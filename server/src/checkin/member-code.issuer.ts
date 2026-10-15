import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';
import { MemberCodeService, MEMBER_CODE_SLOT_SECONDS } from './member-code.service';

export interface MyCheckInCode {
  /** `GOTM1.<memberCode>.<slot>.<mac>` — what the phone renders into a QR. */
  payload: string;
  memberCode: string;
  /** When this one stops being minted. The verifier still accepts one slot back. */
  expiresAt: string;
  /** So the phone can schedule its own refresh without a clock of its own. */
  slotSeconds: number;
}

/**
 * Mints the member's own fallback code.
 *
 * ONE SLOT AT A TIME, unlike the station display's batch of ten.
 *
 * The station mints a batch because a wall panel must keep rendering through a
 * network blip — that is the whole reason the batch exists. A member's phone
 * has the opposite property: if it has no connectivity it cannot reach this
 * endpoint at all, so a batch would only widen the window in which a
 * screenshot still works. Sixty seconds of validity, refreshed on demand.
 */
@Injectable()
export class MemberCodeIssuer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: MemberCodeService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async issue(userId: string, now: Date = new Date()): Promise<MyCheckInCode> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { memberCode: true },
    });

    // memberCode is allocated lazily, so a brand-new account can genuinely not
    // have one yet. A named domain error rather than a 500, because the portal
    // has something useful to say about it.
    if (user?.memberCode == null) {
      throw new DomainException(
        'MEMBER_CODE_NOT_ISSUED',
        'You do not have a member code yet. The front desk can issue one.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const secret: string = this.config.get('STATION_TOKEN_SECRET');
    const slot = this.codes.computeSlot(now);
    const mac = this.codes.sign(userId, slot, secret);

    return {
      payload: this.codes.buildPayload(user.memberCode, slot, mac),
      memberCode: user.memberCode,
      expiresAt: this.codes.slotBounds(slot).notAfter.toISOString(),
      slotSeconds: MEMBER_CODE_SLOT_SECONDS,
    };
  }

  /**
   * Resolves a scanned payload to a member id, or throws the one error the
   * desk is allowed to see.
   *
   * Every failure mode collapses to a single message on purpose. Telling a
   * scanner "that member code does not exist" versus "that signature is wrong"
   * turns the desk into an oracle for which six-character codes are real.
   * Staleness is the one exception, because "hold it up again" is a genuinely
   * different instruction from "that is not a valid code".
   */
  async resolveScan(
    payload: string,
    now: Date = new Date(),
  ): Promise<{ userId: string; memberCode: string }> {
    const parsed = this.codes.parsePayload(payload);

    const member =
      parsed === null
        ? null
        : await this.prisma.user.findUnique({
            where: { memberCode: parsed.memberCode },
            select: { id: true },
          });

    const secrets = [
      this.config.get('STATION_TOKEN_SECRET'),
      this.config.get('STATION_TOKEN_SECRET_PREVIOUS', { infer: true }),
    ].filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);

    const outcome = this.codes.verify({
      payload,
      member: member === null ? null : { userId: member.id },
      secrets,
      now,
    });

    switch (outcome.kind) {
      case 'VALID':
        return { userId: outcome.userId, memberCode: outcome.memberCode };

      case 'EXPIRED':
        throw new DomainException(
          'MEMBER_CODE_EXPIRED',
          'That code has expired. Ask them to refresh it and hold it up again.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );

      case 'NOT_YET_VALID':
      case 'INVALID':
      default:
        throw new DomainException(
          'MEMBER_CODE_INVALID',
          'That is not a valid member code.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
    }
  }
}
