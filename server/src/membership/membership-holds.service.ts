import { HttpStatus, Injectable } from '@nestjs/common';
import {
  DiscountType,
  HoldStatus,
  MembershipEventType,
  MembershipStatus,
  PaymentMethod,
  PaymentPurpose,
  type Prisma,
} from '@prisma/client';
import { MembershipStatus as SharedStatus } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { hashRequestBody } from '../common/idempotency/request-hash';
import {
  addDays,
  asCivilDate,
  civilDateFromPrisma,
  gymToday,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import type { AuthUser } from '../auth/auth.types';
import { PaymentsService } from '../payments/payments.service';
import { ShiftsService } from '../payments/shifts.service';
import { MembershipService } from './membership.service';
import { assertTransition } from './membership-transitions';
import { assertFreezeAllowed } from './membership-freeze-rules';
import { writeMembershipEvent } from './membership-events';
import {
  holdClawBackDelta,
  holdDaysRequested,
  holdStartDelta,
  type HoldDelta,
} from './membership-terms';
import type { MembershipDetail } from './membership.presenter';
import type { FreezeMembershipDto, UnfreezeMembershipDto } from './dto/freeze-membership.dto';

const MS_PER_DAY = 86_400_000;

/**
 * Transitions 7, 8, 9 and 10.
 *
 * The whole point of this file is that `endsOn += daysRequested` exists exactly
 * once (in `activateHoldInTx` and its same-day twin inside `freeze`) and
 * `endsOn -= unused` exists exactly once (in `clawBackInTx`). The nightly job
 * calls these helpers rather than reimplementing the arithmetic — a second copy
 * is precisely the bug §5.6.2 is written to prevent.
 *
 * Prisma's generated enums are literal unions and @got/shared's are TS enums:
 * same strings, different nominal types, so the pure helpers take one cast at
 * the boundary and the database writes use the Prisma values.
 */
@Injectable()
export class MembershipHoldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly memberships: MembershipService,
    private readonly payments: PaymentsService,
    private readonly shifts: ShiftsService,
  ) {}

  async freeze(
    actor: AuthUser,
    membershipId: string,
    dto: FreezeMembershipDto,
    now: Date,
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);
    const startsOn = asCivilDate(dto.startsOn);
    const endsOn = asCivilDate(dto.endsOn);

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);
      const plan = await tx.plan.findUniqueOrThrow({ where: { id: membership.planId } });

      assertFreezeAllowed(
        {
          status: membership.status as unknown as SharedStatus,
          planFreezable: plan.freezable,
          freezesUsedThisTerm: membership.freezesUsedThisTerm,
          startsOn,
          endsOn,
          today,
          rollingHoldDaysLast365: await this.rollingHoldDays(tx, membershipId, today),
        },
        {
          minDays: this.gym.freezeMinDays,
          maxDays: this.gym.freezeMaxDays,
          annualCapDays: this.gym.freezeAnnualCapDays,
        },
      );

      const daysRequested = holdDaysRequested(startsOn, endsOn);
      // §5.6.3: a same-day hold has no window. Deferring it to the nightly job
      // would bank the days while leaving the member ACTIVE — and therefore
      // admitted — for up to a full day. They would get both.
      const sameDay = startsOn === today;

      const hold = await tx.membershipHold.create({
        data: {
          membershipId,
          status: sameDay ? HoldStatus.ACTIVE : HoldStatus.SCHEDULED,
          startsOn: toDateColumn(startsOn),
          endsOn: toDateColumn(endsOn),
          daysRequested,
          daysApplied: sameDay ? daysRequested : 0,
          activeMembershipId: sameDay ? membershipId : null,
          reason: dto.reason,
          feeWaived: dto.feeWaived ?? false,
          approvedById: actor.id,
        },
      });

      if (sameDay) {
        assertTransition(membership.status as unknown as SharedStatus, SharedStatus.FROZEN);

        const previousEndsOn = civilDateFromPrisma(membership.endsOn);
        const newEndsOn = addDays(previousEndsOn, holdStartDelta(daysRequested).endsOnDaysDelta);

        await tx.membership.update({
          where: { id: membershipId },
          data: {
            status: MembershipStatus.FROZEN,
            endsOn: toDateColumn(newEndsOn),
            freezesUsedThisTerm: { increment: 1 },
          },
        });

        await writeMembershipEvent(tx, {
          membershipId,
          type: MembershipEventType.HOLD_APPLIED,
          fromStatus: membership.status,
          toStatus: MembershipStatus.FROZEN,
          previousEndsOn,
          newEndsOn,
          reason: dto.reason,
          actorId: actor.id,
          paymentId: null,
          batchRef: null,
          effectiveAt: now,
        });
      }

      if (!hold.feeWaived && this.gym.freezeFeeCentavos > 0) {
        const fee = this.gym.freezeFeeCentavos;
        const shiftId = await this.shifts.requireOpenShiftId(tx);

        await this.payments.createInTx(tx, {
          userId: membership.userId,
          membershipId,
          planId: membership.planId,
          planCode: membership.planCode,
          planName: membership.planName,
          purpose: PaymentPurpose.FREEZE_FEE,
          amounts: {
            grossCentavos: fee,
            vatBaseCentavos: fee,
            discountCentavos: 0,
            netCentavos: fee,
            vatExempt: false,
          },
          discountType: DiscountType.NONE,
          statutoryIdNo: null,
          discountReason: null,
          termMonths: null,
          termStartsOn: null,
          termEndsOn: null,
          method: dto.method ?? PaymentMethod.CASH,
          reference: dto.reference ?? null,
          gcashVerified: dto.gcashVerified ?? false,
          receiptNo: dto.receiptNo ?? null,
          receivedAt: now,
          businessDate: today,
          shiftId,
          recordedById: actor.id,
          // The route carries no Idempotency-Key: the hold row is the claim, so
          // its id is the natural key for the fee it caused.
          idempotencyKey: `freeze:${hold.id}`,
          idempotencyHash: hashRequestBody({ holdId: hold.id, purpose: 'FREEZE_FEE', fee }),
          notes: null,
        });
      }

      return this.memberships.detailById(tx, membershipId, now);
    });
  }

  async unfreeze(
    actor: AuthUser,
    membershipId: string,
    dto: UnfreezeMembershipDto,
    now: Date,
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);
      if (membership.status !== MembershipStatus.FROZEN) {
        throw new DomainException(
          'MEMBERSHIP_NOT_FROZEN',
          'This membership is not frozen.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      // clawBackInTx owns the arithmetic AND the HOLD_RELEASED event, so the
      // cancel-during-freeze path (row 10) gets the identical ledger entry.
      const delta = await this.clawBackInTx(tx, membershipId, today, now, actor.id);
      if (delta === null) {
        throw new DomainException(
          'MEMBERSHIP_NOT_FROZEN',
          'No running hold to release.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      assertTransition(SharedStatus.FROZEN, SharedStatus.ACTIVE);
      await tx.membership.update({
        where: { id: membershipId },
        data: { status: MembershipStatus.ACTIVE },
      });

      return this.memberships.detailById(tx, membershipId, now);
    });
  }

  /**
   * Nightly step 2. Returns false unless the guarded UPDATE changed exactly one
   * row, so two workers cannot both apply one freeze.
   */
  async activateHoldInTx(
    tx: Prisma.TransactionClient,
    holdId: string,
    _today: CivilDate,
    effectiveAt: Date,
    actorId: string | null,
  ): Promise<boolean> {
    const hold = await tx.membershipHold.findUniqueOrThrow({ where: { id: holdId } });

    const claimed = await tx.membershipHold.updateMany({
      where: { id: holdId, status: HoldStatus.SCHEDULED },
      data: {
        status: HoldStatus.ACTIVE,
        activeMembershipId: hold.membershipId,
        daysApplied: hold.daysRequested,
      },
    });
    if (claimed.count !== 1) return false;

    const membership = await tx.membership.findUniqueOrThrow({ where: { id: hold.membershipId } });
    const previousEndsOn = civilDateFromPrisma(membership.endsOn);
    const newEndsOn = addDays(previousEndsOn, holdStartDelta(hold.daysRequested).endsOnDaysDelta);

    await tx.membership.update({
      where: { id: hold.membershipId },
      data: {
        status: MembershipStatus.FROZEN,
        endsOn: toDateColumn(newEndsOn),
        freezesUsedThisTerm: { increment: 1 },
      },
    });

    await writeMembershipEvent(tx, {
      membershipId: hold.membershipId,
      type: MembershipEventType.HOLD_APPLIED,
      fromStatus: membership.status,
      toStatus: MembershipStatus.FROZEN,
      previousEndsOn,
      newEndsOn,
      reason: hold.reason,
      actorId,
      paymentId: null,
      batchRef: null,
      effectiveAt,
    });

    return true;
  }

  /** Nightly step 1. Pure status flip — the extension was applied at start. */
  async completeHoldInTx(
    tx: Prisma.TransactionClient,
    holdId: string,
    _today: CivilDate,
    effectiveAt: Date,
    actorId: string | null,
  ): Promise<boolean> {
    const hold = await tx.membershipHold.findUniqueOrThrow({ where: { id: holdId } });

    const claimed = await tx.membershipHold.updateMany({
      where: { id: holdId, status: HoldStatus.ACTIVE },
      data: {
        status: HoldStatus.COMPLETED,
        activeMembershipId: null,
        releasedAt: effectiveAt,
        releasedById: actorId,
      },
    });
    if (claimed.count !== 1) return false;

    const membership = await tx.membership.findUniqueOrThrow({ where: { id: hold.membershipId } });
    await tx.membership.update({
      where: { id: hold.membershipId },
      data: { status: MembershipStatus.ACTIVE },
    });

    await writeMembershipEvent(tx, {
      membershipId: hold.membershipId,
      type: MembershipEventType.HOLD_RELEASED,
      fromStatus: membership.status,
      toStatus: MembershipStatus.ACTIVE,
      previousEndsOn: null,
      newEndsOn: null,
      reason: 'completed',
      actorId,
      paymentId: null,
      batchRef: null,
      effectiveAt,
    });

    return true;
  }

  /** Row 9's arithmetic, shared by unfreeze and by cancel-during-freeze. */
  async clawBackInTx(
    tx: Prisma.TransactionClient,
    membershipId: string,
    today: CivilDate,
    effectiveAt: Date,
    actorId: string | null,
  ): Promise<HoldDelta | null> {
    const hold = await tx.membershipHold.findUnique({
      where: { activeMembershipId: membershipId },
    });
    if (!hold) return null;

    const delta = holdClawBackDelta(
      { endsOn: civilDateFromPrisma(hold.endsOn), daysApplied: hold.daysApplied },
      today,
    );

    const claimed = await tx.membershipHold.updateMany({
      where: { id: hold.id, status: HoldStatus.ACTIVE },
      data: {
        status: HoldStatus.COMPLETED,
        activeMembershipId: null,
        releasedAt: effectiveAt,
        releasedById: actorId,
        daysApplied: { increment: delta.daysAppliedDelta },
      },
    });
    if (claimed.count !== 1) return null;

    const membership = await tx.membership.findUniqueOrThrow({ where: { id: membershipId } });
    const previousEndsOn = civilDateFromPrisma(membership.endsOn);
    const newEndsOn = addDays(previousEndsOn, delta.endsOnDaysDelta);

    await tx.membership.update({
      where: { id: membershipId },
      data: { endsOn: toDateColumn(newEndsOn) },
    });

    await writeMembershipEvent(tx, {
      membershipId,
      type: MembershipEventType.HOLD_RELEASED,
      fromStatus: MembershipStatus.FROZEN,
      toStatus: MembershipStatus.ACTIVE,
      previousEndsOn,
      newEndsOn,
      reason: 'early',
      actorId,
      paymentId: null,
      batchRef: null,
      effectiveAt,
    });

    return delta;
  }

  /** Days held across holds overlapping [today − 365, today], cancelled excluded. */
  private async rollingHoldDays(
    tx: Prisma.TransactionClient,
    membershipId: string,
    today: CivilDate,
  ): Promise<number> {
    const windowStart = new Date(toDateColumn(today).getTime() - 365 * MS_PER_DAY);
    const holds = await tx.membershipHold.findMany({
      where: {
        membershipId,
        status: { not: HoldStatus.CANCELLED },
        endsOn: { gte: windowStart },
      },
      select: { daysRequested: true },
    });
    return holds.reduce((total, hold) => total + hold.daysRequested, 0);
  }
}
