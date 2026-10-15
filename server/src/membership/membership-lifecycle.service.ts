import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { MembershipEventType, MembershipStatus } from '@prisma/client';
import { MembershipStatus as SharedStatus } from '@got/shared';
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
  type CivilDate,
} from '../common/time/gym-time';
import type { AuthUser } from '../auth/auth.types';
import { MembershipService } from './membership.service';
import { MembershipHoldsService } from './membership-holds.service';
import { assertTransition, TRANSITION_BYPASS_REASON_REQUIRED } from './membership-transitions';
import { writeMembershipEvent } from './membership-events';
import type { MembershipDetail } from './membership.presenter';
import type { CancelMembershipDto, RequestCancellationDto } from './dto/cancellation.dto';
import type { AdjustTermDto, CorrectMembershipDto } from './dto/adjust-term.dto';

/**
 * Transitions 5, 6, 13, 16 and 17 — everything that changes a membership
 * without money changing hands.
 *
 * Four of the five call assertTransition at the top. The fifth, `correct()`,
 * is the ONE documented bypass (§5.5.3), and it pays for that with a mandatory
 * reason enforced in three places: the DTO, this service, and
 * MembershipEvent_reason_required.
 *
 * Notice and termination are deliberately different operations on different
 * keys. Notice is counter work (membership.cancel.request, FRONT_DESK) and
 * leaves the row ACTIVE with its term intact; termination forfeits the
 * remaining days and belongs to the owner (membership.cancel, ADMIN,
 * dangerous). Collapsing them would put "you lose the rest of the month" in the
 * hands of whoever is on the desk at 19:00.
 *
 * Prisma's generated enums are literal unions and @got/shared's are TS enums:
 * same strings, different nominal types, so assertTransition takes one cast at
 * the boundary and the database writes use the Prisma values.
 */
@Injectable()
export class MembershipLifecycleService {
  private readonly logger = new Logger(MembershipLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly memberships: MembershipService,
    private readonly holds: MembershipHoldsService,
  ) {}

  /** Route 24 — §5.5.2 row 5. */
  async requestCancellation(
    actor: AuthUser,
    membershipId: string,
    dto: RequestCancellationDto,
    now: Date,
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);

      if (membership.status === MembershipStatus.CANCELLED) {
        throw new DomainException(
          'MEMBERSHIP_ALREADY_CANCELLED',
          'This membership is already cancelled — there is nothing left to give notice on.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (membership.status !== MembershipStatus.ACTIVE) {
        throw new DomainException(
          'MEMBERSHIP_NOT_ACTIVE',
          `A ${membership.status} membership has no running term to give notice on.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      assertTransition(SharedStatus.ACTIVE, SharedStatus.ACTIVE);

      // Guarded UPDATE rather than a second refusal: a member who says "I'm
      // cancelling" twice at the counter has not made an error, and a 422 for
      // it would train staff to click through errors. The guard is what makes
      // the second call write no second event.
      const claimed = await tx.membership.updateMany({
        where: { id: membershipId, status: MembershipStatus.ACTIVE, cancelRequestedOn: null },
        data: { cancelRequestedOn: toDateColumn(today) },
      });

      if (claimed.count === 1) {
        await writeMembershipEvent(tx, {
          membershipId,
          type: MembershipEventType.CANCELLATION_REQUESTED,
          fromStatus: MembershipStatus.ACTIVE,
          toStatus: MembershipStatus.ACTIVE,
          // The term does not move: notice is honoured to its end.
          previousEndsOn: null,
          newEndsOn: null,
          reason: dto.reason,
          actorId: actor.id,
          paymentId: null,
          batchRef: null,
          effectiveAt: now,
        });
        this.logger.log(`notice membership=${membershipId} on=${today} actor=${actor.id}`);
      }

      return this.memberships.detailById(tx, membershipId, now);
    });
  }

  /** Route 25 — §5.5.2 row 6. */
  async withdrawCancellation(
    actor: AuthUser,
    membershipId: string,
    now: Date,
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);
      const endsOn = civilDateFromPrisma(membership.endsOn);

      // Three ways there is nothing to withdraw, one code. Row 6 is "notice
      // withdrawn BEFORE endsOn": once the term has run out the nightly job has
      // either already flipped the row to CANCELLED or is about to, and
      // un-cancelling is a reactivation (route 23), not a withdrawal.
      if (
        membership.status !== MembershipStatus.ACTIVE ||
        membership.cancelRequestedOn === null ||
        today > endsOn
      ) {
        throw new DomainException(
          'MEMBERSHIP_INVALID_TRANSITION',
          'There is no notice on a running term to withdraw. Reactivate by renewing instead.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      assertTransition(SharedStatus.ACTIVE, SharedStatus.ACTIVE);

      await tx.membership.update({
        where: { id: membershipId },
        data: { cancelRequestedOn: null },
      });

      await writeMembershipEvent(tx, {
        membershipId,
        type: MembershipEventType.CANCELLATION_WITHDRAWN,
        fromStatus: MembershipStatus.ACTIVE,
        toStatus: MembershipStatus.ACTIVE,
        previousEndsOn: null,
        newEndsOn: null,
        reason: 'notice withdrawn',
        actorId: actor.id,
        paymentId: null,
        batchRef: null,
        effectiveAt: now,
      });

      this.logger.log(`notice withdrawn membership=${membershipId} actor=${actor.id}`);
      return this.memberships.detailById(tx, membershipId, now);
    });
  }

  /** Route 28 — §5.5.2 rows 13 and 10. */
  async cancel(
    actor: AuthUser,
    membershipId: string,
    dto: CancelMembershipDto,
    now: Date,
  ): Promise<MembershipDetail> {
    assertConfirmed(dto);
    const today = gymToday(now, this.gym.timeZone);

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);

      if (membership.status === MembershipStatus.CANCELLED) {
        throw new DomainException(
          'MEMBERSHIP_ALREADY_CANCELLED',
          'This membership is already cancelled.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      assertTransition(membership.status as unknown as SharedStatus, SharedStatus.CANCELLED);

      // Row 10: the claw-back runs FIRST and owns both the arithmetic and its
      // HOLD_RELEASED entry, so the terminate-during-freeze path produces the
      // identical ledger to an early release. A second copy of
      // `endsOn -= unused` here is the exact bug §5.6.2 is written to prevent.
      if (membership.status === MembershipStatus.FROZEN) {
        await this.holds.clawBackInTx(tx, membershipId, today, now, actor.id);
      }

      await tx.membership.update({
        where: { id: membershipId },
        data: {
          status: MembershipStatus.CANCELLED,
          // Membership_cancel_shape is biconditional: this column and the
          // status are set together or not at all.
          cancelledOn: toDateColumn(today),
          // endsOn is left exactly where it was. It is history — "what did they
          // pay for" must still be answerable after a termination.
        },
      });

      await writeMembershipEvent(tx, {
        membershipId,
        type: MembershipEventType.CANCELLED,
        fromStatus: membership.status,
        toStatus: MembershipStatus.CANCELLED,
        previousEndsOn: null,
        newEndsOn: null,
        // Mandatory for CANCELLED (§5.8.4). The DTO already enforces the same
        // bound; this is the value the CHECK will see.
        reason: dto.reason,
        actorId: actor.id,
        paymentId: null,
        batchRef: null,
        effectiveAt: now,
      });

      this.logger.log(
        `terminated membership=${membershipId} from=${membership.status} on=${today} ` +
          `actor=${actor.id}`,
      );
      return this.memberships.detailById(tx, membershipId, now);
    });
  }

  /** Route 29 — §5.5.2 row 16. */
  async adjustTerm(
    actor: AuthUser,
    membershipId: string,
    dto: AdjustTermDto,
    now: Date,
  ): Promise<MembershipDetail> {
    assertConfirmed(dto);

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);

      // Row 16 applies to ACTIVE, EXPIRED and FROZEN and leaves the status
      // where it is. CANCELLED -> CANCELLED is not in the table, so a comp on a
      // terminated membership is refused here with no extra branch: there is no
      // term to extend, and reactivating is a sale.
      assertTransition(
        membership.status as unknown as SharedStatus,
        membership.status as unknown as SharedStatus,
      );

      const previousEndsOn = civilDateFromPrisma(membership.endsOn);
      const newEndsOn = addDays(previousEndsOn, dto.days);

      await tx.membership.update({
        where: { id: membershipId },
        data: { endsOn: toDateColumn(newEndsOn) },
      });

      await writeMembershipEvent(tx, {
        membershipId,
        type: MembershipEventType.ADJUSTED,
        fromStatus: membership.status,
        toStatus: membership.status,
        previousEndsOn,
        newEndsOn,
        reason: dto.reason,
        actorId: actor.id,
        paymentId: null,
        // batchRef is set only by route 32's bulk closure credit, which is what
        // makes a re-run of THAT a no-op. A single comp has no batch.
        batchRef: null,
        effectiveAt: now,
      });

      this.logger.log(
        `comp membership=${membershipId} days=${dto.days} ${previousEndsOn}->${newEndsOn} ` +
          `actor=${actor.id}`,
      );
      return this.memberships.detailById(tx, membershipId, now);
    });
  }

  /** Route 30 — §5.5.2 row 17. The one bypass. */
  async correct(
    actor: AuthUser,
    membershipId: string,
    dto: CorrectMembershipDto,
    now: Date,
  ): Promise<MembershipDetail> {
    assertConfirmed(dto);
    const today = gymToday(now, this.gym.timeZone);

    // membership.status.correct is the ONLY caller permitted to skip
    // assertTransition. The constant is imported and read rather than the call
    // merely omitted, so a reader who greps TRANSITION_BYPASS_REASON_REQUIRED
    // lands here and finds the reason being enforced instead of finding
    // nothing at all.
    const reason = dto.reason.trim();
    if (TRANSITION_BYPASS_REASON_REQUIRED && reason.length < 3) {
      throw new DomainException(
        'MEMBERSHIP_STATE_INVALID',
        'A status correction bypasses the transition table and requires a reason.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const nothingSupplied =
      dto.status === undefined &&
      dto.startsOn === undefined &&
      dto.endsOn === undefined &&
      dto.billingAnchorDay === undefined;
    if (nothingSupplied) {
      throw new DomainException(
        'MEMBERSHIP_STATE_INVALID',
        'A correction must change at least one of status, startsOn, endsOn or billingAnchorDay.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);

      const previousEndsOn = civilDateFromPrisma(membership.endsOn);
      // asCivilDate, not the raw DTO string: IsGymDate checks the shape and
      // this checks the calendar, so '2026-02-31' is refused before it reaches
      // a @db.Date column.
      const startsOn: CivilDate =
        dto.startsOn === undefined
          ? civilDateFromPrisma(membership.startsOn)
          : asCivilDate(dto.startsOn);
      const endsOn: CivilDate = dto.endsOn === undefined ? previousEndsOn : asCivilDate(dto.endsOn);

      // Membership_dates_ordered, checked here so the desk gets a sentence
      // rather than a constraint name.
      if (endsOn < startsOn) {
        throw new DomainException(
          'MEMBERSHIP_STATE_INVALID',
          `endsOn ${endsOn} precedes startsOn ${startsOn}.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      const status =
        dto.status === undefined ? membership.status : (dto.status as unknown as MembershipStatus);
      const cancelling = status === MembershipStatus.CANCELLED;

      await tx.membership.update({
        where: { id: membershipId },
        data: {
          status,
          startsOn: toDateColumn(startsOn),
          endsOn: toDateColumn(endsOn),
          billingAnchorDay: dto.billingAnchorDay ?? membership.billingAnchorDay,
          // Derived, never taken from the body: Membership_cancel_shape is
          // biconditional and this is the only way the pair cannot disagree.
          // A correction INTO cancelled that already had a date keeps it.
          cancelledOn: cancelling ? (membership.cancelledOn ?? toDateColumn(today)) : null,
          // A row corrected off CANCELLED still carries the notice that led
          // there, and that notice is now wrong too.
          cancelRequestedOn: cancelling ? membership.cancelRequestedOn : null,
        },
      });

      const moved = endsOn !== previousEndsOn || dto.endsOn !== undefined;

      await writeMembershipEvent(tx, {
        membershipId,
        type: MembershipEventType.STATUS_CORRECTED,
        fromStatus: membership.status,
        toStatus: status,
        // MembershipEvent_dates_paired: both or neither. Before and after go in
        // the date columns whenever endsOn was part of the correction.
        previousEndsOn: moved ? previousEndsOn : null,
        newEndsOn: moved ? endsOn : null,
        reason,
        actorId: actor.id,
        paymentId: null,
        batchRef: null,
        effectiveAt: now,
      });

      this.logger.warn(
        `CORRECTED membership=${membershipId} ${membership.status}->${status} ` +
          `term=${startsOn}..${endsOn} actor=${actor.id} reason="${reason}"`,
      );
      return this.memberships.detailById(tx, membershipId, now);
    });
  }
}
