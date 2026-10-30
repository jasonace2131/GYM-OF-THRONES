import { BadRequestException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import type { MemberJoinAccepted, MemberJoinClaim, MemberJoinLookup } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import type { Env } from '../config/env.validation';
import { resolveAppOrigin } from '../config/app-origin';
import { DomainException } from '../common/exceptions/domain.exception';
import { gymToday, toDateColumn } from '../common/time/gym-time';
import { SupabaseAdminService } from '../auth/supabase-admin.service';
import { asBirthDate } from '../auth/jwt-verifier';
import { ageRequirementNotMet, isOldEnoughForAccount } from '../auth/minimum-age';
import { EmailService } from '../notifications/email.service';
import { hashInvitationToken, newInvitationToken } from '../staff-invitations/invitation-token';

/** Owner decision (2026-10-14): a member's setup link lives a week, like a staff invitation. */
export const MEMBER_JOIN_TTL_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Counter sign-up — a staff-created member's own setup link.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY NOT JUST EMAIL SUPABASE'S LINK.
 *
 * A raw Supabase link lasts about an hour and a mail scanner that pre-fetches
 * it uses it up, so a member who opens their email that evening found it dead.
 * And it signed them in without ever asking for a password, so the next time
 * they were signed out they were locked out. This link is ours: it lives 7 days,
 * works once, and only asks Supabase for a sign-in link when the member presses
 * "Set up my account" — scanners do not press buttons. The page then asks for a
 * password before it calls `accept`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A LINK IS A WAY INTO THE ACCOUNT, so one is only ever issued for a member who
 * has never signed in (`lastSeenAt` null). A desk login can therefore never mint
 * its way into an active member's account; somebody who has signed in before
 * uses "Forgot password" like everyone else. And only for a member (`CLIENT`)
 * account: a staff account is set up from Staff & Access, so a desk login can
 * never point a staff account's link, or its email, at an inbox of its own.
 */
@Injectable()
export class MemberJoinService {
  private readonly logger = new Logger(MemberJoinService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly config: ConfigService<Env, true>,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly email: EmailService,
  ) {}

  /**
   * Create or ROTATE the member's link and email it. Called by member creation,
   * "Resend invite" and an email correction. Answers whether the email went —
   * the link exists either way, and staff can resend.
   */
  async issue(
    input: { userId: string; issuedById: string; requestOrigin: string | undefined },
    now: Date = new Date(),
  ): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        lastSeenAt: true,
        deletedAt: true,
        membership: { select: { planName: true, endsOn: true, status: true } },
      },
    });
    if (user === null || user.deletedAt !== null) {
      throw new DomainException('MEMBER_NOT_FOUND', 'Member not found', HttpStatus.NOT_FOUND);
    }
    if (user.role !== Role.CLIENT) throw staffAccount();
    if (user.lastSeenAt !== null) throw alreadySignedIn();

    const { token, tokenHash } = newInvitationToken();
    const data = {
      tokenHash,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + MEMBER_JOIN_TTL_DAYS * DAY_MS),
      issuedById: input.issuedById,
    };

    // Rotate an unused link in place; create the first one. A USED link is never
    // touched — `usedAt: null` in the WHERE is the guard. `createMany` with
    // skipDuplicates, never a caught P2002, so a concurrent first issue (a double
    // click) lands as a second rotation instead of an error.
    const rotated = await this.prisma.memberJoinLink.updateMany({
      where: { userId: user.id, usedAt: null },
      data,
    });
    if (rotated.count === 0) {
      const created = await this.prisma.memberJoinLink.createMany({
        data: [{ userId: user.id, ...data }],
        skipDuplicates: true,
      });
      if (created.count === 0) {
        const retried = await this.prisma.memberJoinLink.updateMany({
          where: { userId: user.id, usedAt: null },
          data,
        });
        if (retried.count === 0) throw used();
      }
    }

    const link = `${this.appOrigin(input.requestOrigin)}/join/${token}`;
    try {
      await this.email.sendMemberJoin(user.email, {
        name: `${user.firstName} ${user.lastName}`.trim(),
        link,
        plan: this.planLine(user.membership, now),
      });
      return true;
    } catch (err) {
      this.logger.warn(`Setup link email failed for member ${user.id}: ${String(err)}`);
      return false;
    }
  }

  /**
   * `GET /member-join/lookup` — PUBLIC. The email, and whether to ask for a date
   * of birth, only while the link is usable.
   */
  async lookup(token: string, now: Date = new Date()): Promise<MemberJoinLookup> {
    const row = await this.findByToken(token);
    const status = statusOf(row, now);
    return status === 'PENDING'
      ? {
          firstName: row.user.firstName,
          status,
          email: row.user.email,
          needsDateOfBirth: row.user.dateOfBirth === null,
        }
      : { firstName: row.user.firstName, status };
  }

  /** `POST /member-join/claim-link` — PUBLIC. "Set up my account". */
  async claimLink(
    token: string,
    requestOrigin: string | undefined,
    now: Date = new Date(),
  ): Promise<MemberJoinClaim> {
    const row = await this.findByToken(token);
    assertUsable(row, now);
    // A member promoted to staff before finishing setup is a staff account now.
    if (row.user.role !== Role.CLIENT) throw staffAccount();
    const redirectTo = `${this.appOrigin(requestOrigin)}/join/${token}`;
    const minted = await this.supabaseAdmin.memberJoinSignInLink(row.user.email, redirectTo);
    // Supabase mints for whichever account holds the address. Anything but this
    // member's own (an imported member's fabricated id, the two emails drifting
    // apart) would sign somebody else in, so the link is dropped, never returned.
    if (minted.userId !== row.user.supabaseId) {
      this.logger.warn(
        `Setup link for member ${row.userId} minted a sign-in for another Supabase account; refused`,
      );
      throw notFound();
    }
    return { url: minted.actionLink };
  }

  /**
   * `POST /member-join/accept` — the member, signed in through the link, has just
   * set a password (the page does that with Supabase before calling this).
   *
   * Idempotent for the member themselves: a double submit, or a lost race against
   * their own first submit, answers the same success rather than a "used" error
   * on a page that has, in fact, worked.
   *
   * Expiry gates the CLAIM, not this. The member is already signed in through
   * the link and their password is already saved; refusing them in the last
   * minutes of day 7 would strand them, because staff cannot resend to somebody
   * who has signed in.
   *
   * A date of birth already on file (the desk entered it) is kept, and the page
   * did not ask for one. Otherwise one is required, and under 12 is refused
   * (owner, 2026-10-30), both BEFORE the link is claimed, so a refusal never
   * uses it up. The page checks first, before it saves the password.
   */
  async accept(
    callerId: string,
    token: string,
    dateOfBirth: string | undefined,
    now: Date = new Date(),
  ): Promise<MemberJoinAccepted> {
    const row = await this.findByToken(token);
    if (row.userId !== callerId) {
      throw new DomainException(
        'MEMBER_JOIN_WRONG_ACCOUNT',
        'You are signed in with a different account. Sign out, then open the link again.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (row.usedAt !== null) return { dateOfBirthSaved: false };

    let birth: string | null = null;
    if (row.user.dateOfBirth === null) {
      if (dateOfBirth === undefined) throw new BadRequestException('Enter your date of birth.');
      birth = asBirthDate(dateOfBirth, now.getTime());
      if (birth !== null && !isOldEnoughForAccount(birth, now.getTime())) {
        throw ageRequirementNotMet(HttpStatus.BAD_REQUEST);
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.memberJoinLink.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count === 0 || birth === null) return { dateOfBirthSaved: false };
      // Never overwrites: a birthday on file is corrected by staff, not by a link.
      const saved = await tx.user.updateMany({
        where: { id: row.userId, dateOfBirth: null },
        data: { dateOfBirth: new Date(`${birth}T00:00:00.000Z`) },
      });
      return { dateOfBirthSaved: saved.count === 1 };
    });
  }

  private planLine(
    membership: { planName: string; endsOn: Date; status: string } | null,
    now: Date,
  ): { name: string; endsOn: string } | null {
    if (membership === null || membership.status === 'CANCELLED') return null;
    const today = toDateColumn(gymToday(now, this.gym.timeZone));
    if (membership.endsOn.getTime() < today.getTime()) return null;
    return {
      name: membership.planName,
      // A @db.Date is UTC midnight; formatting it in UTC keeps the calendar day.
      endsOn: membership.endsOn.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      }),
    };
  }

  private async findByToken(token: string) {
    const row = await this.prisma.memberJoinLink.findUnique({
      where: { tokenHash: hashInvitationToken(token) },
      include: {
        user: {
          select: {
            firstName: true,
            email: true,
            role: true,
            supabaseId: true,
            deletedAt: true,
            dateOfBirth: true,
          },
        },
      },
    });
    if (row === null || row.user.deletedAt !== null) throw notFound();
    return row;
  }

  private appOrigin(requestOrigin: string | undefined): string {
    return resolveAppOrigin(requestOrigin, this.config.get('CORS_ORIGIN', { infer: true }));
  }
}

function statusOf(
  row: { usedAt: Date | null; expiresAt: Date },
  now: Date,
): MemberJoinLookup['status'] {
  if (row.usedAt !== null) return 'USED';
  return row.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'PENDING';
}

function assertUsable(row: { usedAt: Date | null; expiresAt: Date }, now: Date): void {
  switch (statusOf(row, now)) {
    case 'USED':
      throw used();
    case 'EXPIRED':
      throw new DomainException(
        'MEMBER_JOIN_EXPIRED',
        'This setup link has expired. Ask the front desk to send a new one.',
        HttpStatus.GONE,
      );
    case 'PENDING':
      return;
  }
}

function notFound(): DomainException {
  return new DomainException(
    'MEMBER_JOIN_NOT_FOUND',
    "This setup link isn't valid. Ask the front desk to send a new one.",
    HttpStatus.NOT_FOUND,
  );
}

function used(): DomainException {
  return new DomainException(
    'MEMBER_JOIN_USED',
    'This account is already set up. Sign in, or use "Forgot password".',
    HttpStatus.GONE,
  );
}

/** Shared with `MembersService.changeEmail`, which refuses a signed-in member the same way. */
export function alreadySignedIn(): DomainException {
  return new DomainException(
    'MEMBER_ALREADY_SIGNED_IN',
    'They have already signed in. Ask them to use "Forgot password" on the sign-in page.',
    HttpStatus.CONFLICT,
  );
}

/** Shared with `MembersService.changeEmail`, which refuses a staff account the same way. */
export function staffAccount(): DomainException {
  return new DomainException(
    'MEMBER_JOIN_STAFF_ACCOUNT',
    'Staff accounts are set up from Staff & Access, not with a member setup link.',
    HttpStatus.CONFLICT,
  );
}
