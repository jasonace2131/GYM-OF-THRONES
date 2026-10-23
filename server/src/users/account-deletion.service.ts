import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseAdminService } from '../auth/supabase-admin.service';
import { BookingsService } from '../classes/bookings.service';
import { DomainException } from '../common/exceptions/domain.exception';
import type { AuthUser } from '../auth/auth.types';
import { eraseAuthIdentity, selfDeletedEmail } from './auth-erasure';

/** What a required free-text column becomes when its text has to go. */
export const REDACTED = 'Redacted';

/**
 * What the `User` row becomes. Every column that identifies the person or
 * describes their health is wiped; `id` stays, because payments, memberships,
 * visits, bookings and audit entries point at it and are the gym's records.
 *
 * - The email becomes `selfDeletedEmail(id)` — unique, undeliverable, and the
 *   marker that this was a SELF-deletion (staff restore refuses it).
 * - `memberCode` is cleared: nothing references it, and a lookup handle for a
 *   person who no longer exists is only a way to find their old records.
 * - `supabaseId` stays: NOT NULL and UNIQUE; the identity it names is deleted
 *   right after this commits (or by the scheduler's retry).
 * - `status` and the suspension trio stay: the `User_suspend_*` CHECKs tie
 *   them together, and a suspension is the gym's record, not the member's data.
 */
export function anonymisedUserData(userId: string, now: Date) {
  return {
    firstName: 'Deleted',
    lastName: 'member',
    email: selfDeletedEmail(userId),
    phone: null,
    avatarUrl: null,
    memberCode: null,
    seniorPwdIdNo: null,
    dateOfBirth: null,
    heightCm: null,
    weightKg: null,
    medicalNotes: null,
    shareMedicalWithPlanner: false,
    emergencyContact: null,
    emergencyContactName: null,
    emergencyContactPhone: null,
    emergencyContactRelation: null,
    deletedAt: now,
  } satisfies Prisma.UserUpdateManyMutationInput;
}

/**
 * `POST /me/delete-account` — a member deletes their own account, at once
 * (owner, 2026-10-23), under the Data Privacy Act (RA 10173): personal data
 * is erased, the gym's financial and attendance records are kept.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ORDER: LOCAL ERASURE FIRST, SUPABASE LAST.
 *
 * 1. The password, checked against Supabase. Wrong → nothing changes.
 * 2. Future bookings, each through `BookingsService.cancel` (its own
 *    transaction and lock), so a freed seat goes to the waitlist exactly as if
 *    the member had cancelled it.
 * 3. ONE transaction: anonymise the row and set `deletedAt` (conditional on
 *    `deletedAt IS NULL`, so a double submit changes nothing twice), close an
 *    open visit, end a coach assignment, delete the member's own health and
 *    workout records, redact personal text on kept records, write the audit
 *    row. From here on the API refuses this account (AuthGuard on deletedAt).
 * 4. Delete the Supabase identity. A failure here does NOT fail the request —
 *    the personal data is already gone and the API already refuses the
 *    account — it leaves `authErasedAt` NULL, and the scheduler's
 *    `eraseDeletedAuth` job retries until Supabase deletes it or says
 *    "not found".
 *
 * The reverse order (Supabase first) could strand a member: identity gone,
 * the local transaction failed, real data still on the row and no way left to
 * sign in and retry.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Kept, deliberately (owner, 2026-10-23): payments, GCash proofs,
 * memberships and their events, visits and denials, class bookings, consent
 * records, audit entries, coach chat messages and CoachAssignment notes —
 * the last two shown under "Deleted member".
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseAdminService,
    private readonly bookings: BookingsService,
  ) {}

  async deleteOwnAccount(user: AuthUser, password: string, now: Date = new Date()): Promise<void> {
    // Members only. A staff account holds other people's history (payments
    // recorded, visits closed) under its name, and is closed by an admin.
    if (user.role !== 'CLIENT') {
      throw new DomainException(
        'ACCOUNT_DELETE_NOT_ALLOWED',
        'Staff accounts are closed by an admin, not from here.',
        HttpStatus.FORBIDDEN,
      );
    }

    const check = await this.supabase.verifyPassword(user.email, password);
    if (check === 'wrong') {
      throw new DomainException(
        'WRONG_PASSWORD',
        "That's not your current password.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (check === 'error') {
      throw new DomainException(
        'ACCOUNT_DELETE_FAILED',
        "Couldn't check your password just now. Nothing was changed — try again in a moment.",
        HttpStatus.BAD_GATEWAY,
      );
    }

    const plan = await this.prisma.membership.findUnique({
      where: { userId: user.id },
      select: { status: true },
    });

    const bookingsCancelled = await this.cancelFutureBookings(user.id, now);

    const erased = await this.prisma.$transaction(async (tx) => {
      const marked = await tx.user.updateMany({
        where: { id: user.id, deletedAt: null },
        data: anonymisedUserData(user.id, now),
      });
      // Already deleted by a concurrent submit: that one did everything.
      if (marked.count === 0) return false;

      const visit = await tx.checkIn.updateMany({
        where: { openUserId: user.id, endedAt: null },
        data: { endedAt: now, closeMethod: 'MANUAL', closedById: user.id, openUserId: null },
      });
      const coaching = await tx.coachAssignment.updateMany({
        where: { memberId: user.id, status: 'ACTIVE' },
        data: { status: 'ENDED', endedAt: now, endedById: user.id, activeMemberId: null },
      });

      // Personal health and training data (RA 10173 §3(l)) — deleted, not
      // kept: the gym has no record-keeping need for it. Set logs before
      // sessions, sessions before the plans they point at.
      const byUser = { where: { userId: user.id } };
      const byMember = { where: { memberId: user.id } };
      const counts = [
        await tx.bodyMeasurement.deleteMany(byUser),
        await tx.memberGoal.deleteMany(byUser),
        await tx.workoutSetLog.deleteMany(byMember),
        await tx.workoutSession.deleteMany(byMember),
        await tx.memberWorkoutDraft.deleteMany(byMember),
        await tx.memberWorkoutPlan.deleteMany(byMember),
        await tx.workoutPlan.deleteMany(byMember),
        await tx.workoutAiQuota.deleteMany(byMember),
        await tx.aiConversation.deleteMany(byUser),
        await tx.memberNotice.deleteMany(byUser),
        await tx.memberJoinLink.deleteMany(byUser),
      ];

      // Personal text on records the gym KEEPS. Required columns get a fixed
      // word; `Lead_contactable` needs an email or a phone, so the lead takes
      // the same undeliverable placeholder as the account.
      await tx.lead.updateMany({
        where: { convertedUserId: user.id },
        data: {
          name: REDACTED,
          email: selfDeletedEmail(user.id),
          phone: null,
          message: null,
          notes: null,
          originIpHash: null,
        },
      });
      // A freeze reason can be medical ("knee surgery").
      await tx.membershipHold.updateMany({
        where: { membership: { userId: user.id } },
        data: { reason: REDACTED },
      });
      await tx.checkInDenial.updateMany({ where: { userId: user.id }, data: { notes: null } });

      // In the transaction, so the trail exists exactly when the deletion
      // does. COUNTS ONLY: the entry must not be where the name survives.
      await tx.auditLog.create({
        data: {
          action: 'MEMBER_SELF_DELETED',
          actorId: user.id,
          actorRole: user.role,
          subjectType: 'User',
          subjectId: user.id,
          subjectLabel: null,
          details: {
            bookingsCancelled,
            visitClosed: visit.count > 0,
            coachAssignmentEnded: coaching.count > 0,
            personalRecordsDeleted: counts.reduce((sum, { count }) => sum + count, 0),
            hadActivePlan: plan?.status === 'ACTIVE',
          },
          occurredAt: now,
        },
      });
      return true;
    });

    if (!erased) return;

    try {
      await eraseAuthIdentity(this.prisma, this.supabase, user, now);
    } catch (caught) {
      // Not the member's problem: their data is gone and the API refuses them.
      // The scheduler's eraseDeletedAuth job finishes this.
      this.logger.warn(
        `self-delete ${user.id}: Supabase identity not erased yet, left for the retry job — ${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
    }
  }

  private async cancelFutureBookings(userId: string, now: Date): Promise<number> {
    const future = await this.prisma.classBooking.findMany({
      where: {
        userId,
        activeKey: { not: null },
        status: { in: ['BOOKED', 'WAITLISTED'] },
        session: { startsAt: { gt: now }, cancelledAt: null },
      },
      select: { sessionId: true },
    });
    let cancelled = 0;
    for (const { sessionId } of future) {
      try {
        await this.bookings.cancel(userId, sessionId, now);
        cancelled += 1;
      } catch (caught) {
        // A class that started or was cancelled in the meantime: the booking
        // holds no personal data, so it does not stand in the way.
        this.logger.warn(
          `self-delete ${userId}: booking for class ${sessionId} not cancelled — ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        );
      }
    }
    return cancelled;
  }
}
