import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { MembershipEventType, MembershipStatus, Role, type Prisma } from '@prisma/client';
import type { DomainErrorCode } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { assertConfirmed } from '../common/dto/confirm.dto';
import {
  addDays,
  asCivilDate,
  civilDateFromPrisma,
  gymToday,
  toDateColumn,
} from '../common/time/gym-time';
import type { AuthUser } from '../auth/auth.types';
import { allocateMemberCode } from '../users/member-code.util';
import { PlansService } from '../catalogue/plans.service';
import { writeMembershipEvent, writeMembershipEventIfNew } from './membership-events';
import type {
  ImportMemberRowDto,
  ImportMembershipsDto,
  ExtendAllDto,
} from './dto/import-memberships.dto';

/** A 340-row batch is well past Prisma's 5s interactive default. */
const BULK_TRANSACTION_TIMEOUT_MS = 60_000;

export interface ImportRowError {
  row: number;
  email: string | null;
  phone: string | null;
  code: DomainErrorCode;
  message: string;
}

export interface ImportResult {
  created: number;
  skipped: number;
  errors: ImportRowError[];
}

/**
 * §5.5.4 and §5.5.5.
 *
 * This is the ONLY path in the system permitted to create a membership without
 * a Payment. Keying 340 notebook members as fresh sales would fabricate about
 * ₱270,000 of week-one revenue and reset every anniversary.
 *
 * Known, accepted gap: an imported User carries a minted `supabaseId`, because
 * that column is NOT NULL and the member has no auth account yet. Linking the
 * real Supabase account on first login belongs to the member console in Chunk 2;
 * until then a self-registration with the same email collides on User.email.
 */
@Injectable()
export class MembershipImportService {
  private readonly logger = new Logger(MembershipImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly plans: PlansService,
  ) {}

  async importMembers(
    actor: AuthUser,
    dto: ImportMembershipsDto,
    now: Date,
  ): Promise<ImportResult> {
    assertConfirmed(dto);

    let created = 0;
    let skipped = 0;
    const errors: ImportRowError[] = [];

    for (const [index, row] of dto.rows.entries()) {
      try {
        const outcome = await this.importRow(actor, row, now);
        if (outcome === 'created') created += 1;
        else skipped += 1;
      } catch (error) {
        if (!(error instanceof DomainException)) throw error;
        const body = error.getResponse() as { code: DomainErrorCode; message: string };
        errors.push({
          row: index + 1,
          email: row.email ?? null,
          phone: row.phone ?? null,
          code: body.code,
          message: body.message,
        });
      }
    }

    this.logger.log(
      `import actor=${actor.id} rows=${dto.rows.length} created=${created} ` +
        `skipped=${skipped} errors=${errors.length}`,
    );

    return { created, skipped, errors };
  }

  private async importRow(
    actor: AuthUser,
    row: ImportMemberRowDto,
    now: Date,
  ): Promise<'created' | 'skipped'> {
    // One identity key for both cases: when only a phone is on file, a
    // placeholder address is minted so User.email's unique index carries the
    // idempotency for the phone path too.
    const keys = row.email
      ? { current: row.email.trim().toLowerCase(), legacy: null }
      : row.phone
        ? placeholderEmails(row.phone)
        : null;

    if (keys === null) {
      throw new DomainException(
        'MEMBER_NOT_FOUND',
        'This row has neither an email nor a phone, so it identifies no member.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const startsOn = asCivilDate(row.startsOn);
    const endsOn = asCivilDate(row.endsOn);
    const joinedOn = asCivilDate(row.joinedOn);
    if (endsOn < startsOn) {
      throw new DomainException(
        'MEMBERSHIP_STATE_INVALID',
        `endsOn ${endsOn} precedes startsOn ${startsOn}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const plan = await this.plans.requireSellable(tx, row.planCode);

      // A phone-only row imported before phones were normalised was keyed on
      // its 09… digits; re-importing it must find that user, not mint another.
      const legacyHit =
        keys.legacy === null
          ? null
          : await tx.user.findUnique({ where: { email: keys.legacy }, select: { id: true } });
      const email = legacyHit === null ? keys.current : (keys.legacy as string);

      // createMany + skipDuplicates, never catch-then-query: a caught P2002
      // aborts the transaction and every later statement dies with 25P02.
      const claim = await tx.user.createMany({
        data: [
          {
            supabaseId: randomUUID(),
            email,
            firstName: row.firstName,
            lastName: row.lastName,
            phone: row.phone ?? null,
            role: Role.CLIENT,
          },
        ],
        skipDuplicates: true,
      });

      const user = await tx.user.findUniqueOrThrow({
        where: { email },
        select: { id: true, memberCode: true },
      });

      if (claim.count === 0) {
        const existing = await tx.membership.findUnique({
          where: { userId: user.id },
          select: { id: true },
        });
        if (existing) return 'skipped';
      }

      if (!user.memberCode) {
        const memberCode = await allocateMemberCode(tx);
        await tx.user.update({ where: { id: user.id }, data: { memberCode } });
      }

      const membership = await tx.membership.create({
        data: {
          userId: user.id,
          planId: plan.id,
          status: MembershipStatus.ACTIVE,
          planCode: plan.code,
          planName: plan.name,
          planPriceCentavos: plan.priceCentavos,
          termMonths: plan.termMonths ?? 1,
          graceDays: plan.graceDays,
          guestPassesPerTerm: plan.guestPassesPerTerm,
          startsOn: toDateColumn(startsOn),
          endsOn: toDateColumn(endsOn),
          billingAnchorDay: Number(startsOn.slice(8, 10)),
          joinedOn: toDateColumn(joinedOn),
          graceAdmissionsThisTerm: 0,
          freezesUsedThisTerm: 0,
          guestPassesRemaining: plan.guestPassesPerTerm,
          purchasedAt: now,
        },
      });

      await writeMembershipEvent(tx, {
        membershipId: membership.id,
        type: MembershipEventType.IMPORTED,
        fromStatus: null,
        toStatus: MembershipStatus.ACTIVE,
        previousEndsOn: null,
        newEndsOn: null,
        reason: 'imported at go-live',
        actorId: actor.id,
        paymentId: null,
        batchRef: null,
        effectiveAt: now,
      });

      return 'created';
    });
  }

  async extendAll(actor: AuthUser, dto: ExtendAllDto, now: Date): Promise<{ affected: number }> {
    assertConfirmed(dto);
    const today = gymToday(now, this.gym.timeZone);

    const affected = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const targets = await tx.membership.findMany({
          where: { status: { in: [MembershipStatus.ACTIVE, MembershipStatus.FROZEN] } },
          select: { id: true, status: true, endsOn: true },
        });

        let count = 0;
        for (const membership of targets) {
          const previousEndsOn = civilDateFromPrisma(membership.endsOn);
          const newEndsOn = addDays(previousEndsOn, dto.days);

          // The batchRef claim comes FIRST: if it loses, the extension never
          // runs, so a re-run of the same closure moves no date twice.
          const claimed = await writeMembershipEventIfNew(tx, {
            membershipId: membership.id,
            type: MembershipEventType.ADJUSTED,
            fromStatus: membership.status,
            toStatus: membership.status,
            previousEndsOn,
            newEndsOn,
            reason: dto.reason,
            actorId: actor.id,
            paymentId: null,
            batchRef: dto.batchRef,
            effectiveAt: now,
          });
          if (!claimed) continue;

          await tx.membership.update({
            where: { id: membership.id },
            data: { endsOn: toDateColumn(newEndsOn) },
          });
          count += 1;
        }

        return count;
      },
      { timeout: BULK_TRANSACTION_TIMEOUT_MS },
    );

    this.logger.log(
      `extendAll actor=${actor.id} today=${today} days=${dto.days} ` +
        `batchRef=${dto.batchRef} affected=${affected}`,
    );

    return { affected };
  }
}

const PLACEHOLDER_DOMAIN = '@imported.gymofthrones.invalid';

/**
 * The placeholder address that makes a phone-only import idempotent. `current`
 * is keyed on the stored +639XXXXXXXXX digits (639…); `legacy` is the 09… key
 * rows imported before 2026-10-23 carry, or null when the two are the same.
 */
export function placeholderEmails(phone: string): { current: string; legacy: string | null } {
  const digits = phone.replace(/\D/g, '');
  const current = `${digits}${PLACEHOLDER_DOMAIN}`;
  const legacy = /^639\d{9}$/.test(digits) ? `0${digits.slice(2)}${PLACEHOLDER_DOMAIN}` : null;
  return { current, legacy };
}
