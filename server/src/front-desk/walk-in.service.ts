import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type CheckIn } from '@prisma/client';
import { AccessVerdict, DiscountType, type CheckInRecord, LEGAL_VERSIONS } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { hashRequestBody } from '../common/idempotency/request-hash';
import { gymToday, toDateColumn, type CivilDate } from '../common/time/gym-time';
import { computeAmounts } from '../membership/membership-terms';
import { PlansService } from '../catalogue/plans.service';
import { PaymentsService } from '../payments/payments.service';
import { ShiftsService } from '../payments/shifts.service';
import { DeskFeedService } from '../checkin/desk-feed.service';
import type { AuthUser } from '../auth/auth.types';
import type { SellWalkInDto } from './dto/sell-walk-in.dto';
import { toCheckInRecord } from './desk.presenter';
import { requireGuestIdentity } from './guest-identity';

/** The one plan code a walk-in is priced from. */
const WALK_IN_PLAN_CODE = 'WALKIN';

/**
 * Route 49 — the walk-in sale and the guest pass.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS WHAT A DENIAL CONVERTS INTO.
 *
 * A denial is a person standing at a counter who wants to train and cannot.
 * It is the highest-intent sales moment the gym gets and it lasts about ninety
 * seconds. Before this route existed, the console could show staff that
 * moment and offer them nothing to do about it.
 *
 * Passing `denialId` is what closes the funnel: the denial moves to
 * `RESOLVED_WALK_IN` and points at the entry that converted it, so "how many
 * refusals turned into money" is a query rather than a guess.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TWO SALES, ONE ROUTE:
 *
 *   WALK_IN     `Payment` + `CheckIn(entryType = WALK_IN, paymentId)`.
 *   GUEST_PASS  `Membership.guestPassesRemaining` decremented +
 *               `CheckIn(entryType = GUEST_PASS)` and NO `Payment` — which is
 *               exactly why `Payment_amount_positive` never has to be relaxed
 *               for a ₱0 row.
 *
 * `Payment.shiftId` is NOT NULL throughout. Money without a counted drawer is
 * the one thing that cannot be reconciled later, so this route hard-fails with
 * no open shift rather than booking the sale against nothing.
 *
 * THERE IS NO `DayPass` MODEL. Entitlement for the rest of the gym-local
 * business date is derived from the `CheckIn` row this writes, which is what
 * `dayPassValidToday` reads. A second entitlement table would be a second
 * place to ask "may this person train today".
 */
@Injectable()
export class WalkInService {
  private readonly logger = new Logger(WalkInService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly plans: PlansService,
    private readonly payments: PaymentsService,
    private readonly shifts: ShiftsService,
    private readonly deskFeed: DeskFeedService,
  ) {}

  async sell(
    operator: AuthUser,
    dto: SellWalkInDto,
    idempotencyKey: string,
    now: Date = new Date(),
  ): Promise<CheckInRecord> {
    const today = gymToday(now, this.gym.timeZone);

    const record = await this.prisma.$transaction(
      async (tx) => {
        // NOT NULL throughout, and checked first: a sale booked against no
        // drawer is a sale nobody can reconcile at close.
        const shiftId = await this.shifts.requireOpenShiftId(tx);
        const checkIn =
          dto.kind === 'GUEST_PASS'
            ? await this.sellGuestPass(tx, operator, dto, today, now, shiftId)
            : await this.sellWalkIn(tx, operator, dto, today, now, shiftId, idempotencyKey);

        await this.resolveDenial(tx, dto.denialId, checkIn.id, now);

        return this.load(tx, checkIn.id, today);
      },
      { timeout: 8_000 },
    );

    // After commit, never inside it.
    this.deskFeed.publish({
      kind: 'CHECK_IN',
      at: record.occurredAt,
      member: record.member,
      staffMessage:
        dto.kind === 'GUEST_PASS' ? 'Guest pass used. Let them in.' : 'Walk-in paid. Let them in.',
      outcome: 'CHECKED_IN',
      checkInId: record.checkInId,
      denialId: null,
      reason: null,
      verdict: record.verdict,
      station: null,
      offSiteOrigin: false,
      photoOnFileAtTime: record.member.avatarUrl !== null,
    });

    return record;
  }

  // ───────────────────────────────────────────────────────────────────────

  private async sellWalkIn(
    tx: Prisma.TransactionClient,
    operator: AuthUser,
    dto: SellWalkInDto,
    today: CivilDate,
    now: Date,
    shiftId: string,
    idempotencyKey: string,
  ): Promise<CheckIn> {
    const plan = await this.plans.requireSellable(tx, WALK_IN_PLAN_CODE);
    const discountType = dto.discountType ?? DiscountType.NONE;

    /*
     * ─────────────────────────────────────────────────────────────────────
     * THE SAME TWO GUARDS THE OTHER THREE DISCOUNT PATHS USE.
     *
     * This route used to call NEITHER, and it is the only sale a member of
     * staff can ring without `payment.record`: it is gated on `walkin.sell`,
     * which requires only `payment.record` + `checkin.create`. So
     * `payment.discount.statutory` — the key that exists precisely to control
     * who may apply an RA 9994 / RA 10754 discount — was never checked here,
     * and a SENIOR sale with no OSCA number reached the database, where
     * `Payment_discount_shape` rejected it as a generic constraint violation
     * instead of "enter the ID number".
     *
     * The CHECK constraint caught the malformed row. Nothing caught the
     * missing permission.
     * ─────────────────────────────────────────────────────────────────────
     */
    await this.payments.assertDiscountAllowed(operator, discountType);
    this.payments.assertDiscountShape(discountType, dto.statutoryIdNo, undefined);

    /*
     * ─────────────────────────────────────────────────────────────────────
     * A GUEST WITHOUT AN ACCOUNT MUST ACCEPT THE WAIVER TO GET IN.
     *
     * Members accept it in the portal and are gated there; a walk-in used to
     * walk straight past that mechanism entirely, so the person least
     * familiar with the equipment was the only one with no record of having
     * been warned. `dto.userId` present means an existing member is ringing
     * a day pass — theirs is already on file, and asking twice at a busy
     * counter trains staff to click through.
     * ─────────────────────────────────────────────────────────────────────
     */
    requireGuestIdentity(dto);
    if (dto.userId === undefined && dto.guestWaiverAccepted !== true) {
      throw new DomainException(
        'GUEST_WAIVER_REQUIRED',
        'The guest must accept the liability waiver before entry.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const amounts = computeAmounts({
      priceCentavos: plan.priceCentavos,
      discountType,
      // A VAT-registered seller nets out the 12% BEFORE applying the statutory
      // 20%. Getting the order wrong under-charges every senior and PWD sale
      // and is a compliance problem, not a rounding one.
      vatRegistered: this.gym.vatRegistered,
    });

    // The console echoes back what it showed the member. A mismatch means the
    // price list moved under a sheet that was already open, and ringing a
    // different number than the one quoted is worse than refusing.
    if (dto.netCentavos !== undefined && dto.netCentavos !== amounts.netCentavos) {
      throw new DomainException(
        'PAYMENT_AMOUNT_MISMATCH',
        `The collected amount should be ${amounts.netCentavos} centavos, not ${dto.netCentavos}. ` +
          'Reload the price list before ringing this sale.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const payment = await this.payments.createInTx(tx, {
      userId: dto.userId ?? null,
      membershipId: null,
      planId: plan.id,
      planCode: plan.code,
      planName: plan.name,
      purpose: 'WALK_IN',
      amounts,
      discountType,
      statutoryIdNo: dto.statutoryIdNo ?? null,
      discountReason: null,
      termMonths: null,
      termStartsOn: null,
      termEndsOn: null,
      method: dto.method ?? 'CASH',
      reference: dto.reference ?? null,
      gcashVerified: dto.gcashVerified ?? false,
      receiptNo: dto.receiptNo?.trim() ?? null,
      receivedAt: now,
      businessDate: today,
      shiftId,
      recordedById: operator.id,
      idempotencyKey,
      idempotencyHash: hashRequestBody(dto),
      notes: null,
    });

    return this.writeEntry(tx, {
      userId: dto.userId ?? null,
      entryType: 'WALK_IN',
      paymentId: payment.id,
      membershipId: null,
      membershipStatusAtTime: null,
      guestName: dto.userId === undefined ? (dto.guestName ?? null) : null,
      guestPhone: dto.userId === undefined ? (dto.guestPhone ?? null) : null,
      guestEmail: dto.userId === undefined ? (dto.guestEmail ?? null) : null,
      guestWaiver:
        dto.userId === undefined
          ? {
              version: LEGAL_VERSIONS.WAIVER,
              emergencyContact: dto.guestEmergencyContact ?? null,
            }
          : null,
      operator,
      shiftId,
      now,
      today,
    });
  }

  /**
   * A guest pass belongs to a HOST, not to the guest.
   *
   * That is what makes it finite, and what makes running out a conversation
   * with the member rather than with a stranger at the counter.
   */
  private async sellGuestPass(
    tx: Prisma.TransactionClient,
    operator: AuthUser,
    dto: SellWalkInDto,
    today: CivilDate,
    now: Date,
    shiftId: string,
  ): Promise<CheckIn> {
    if (dto.hostMembershipId === undefined) {
      throw new DomainException(
        'MEMBER_HAS_NO_MEMBERSHIP',
        'A guest pass is spent from a host member’s allowance — name the host.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // A CONDITIONAL decrement, not read-then-write. Two staff spending the
    // last pass at once would otherwise both read `1` and both succeed; the
    // `gt: 0` guard in the WHERE means exactly one does.
    const { count } = await tx.membership.updateMany({
      where: { id: dto.hostMembershipId, guestPassesRemaining: { gt: 0 } },
      data: { guestPassesRemaining: { decrement: 1 } },
    });

    if (count === 0) {
      const host = await tx.membership.findUnique({ where: { id: dto.hostMembershipId } });
      throw new DomainException(
        host === null ? 'MEMBERSHIP_NOT_FOUND' : 'GUEST_PASS_EXHAUSTED',
        host === null
          ? 'That membership does not exist.'
          : 'That member has no guest passes left this term.',
        host === null ? HttpStatus.NOT_FOUND : HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    /*
     * THE SAME RULE AS THE WALK-IN, AND FOR A STRONGER REASON.
     *
     * A guest-pass entry is free, so there is no payment step to slow anyone
     * down and no receipt to sign — the guest is brought in by a member and
     * walks onto the floor. If anything, this is the entry most likely to
     * involve somebody who has never trained before.
     */
    requireGuestIdentity(dto);
    if (dto.userId === undefined && dto.guestWaiverAccepted !== true) {
      throw new DomainException(
        'GUEST_WAIVER_REQUIRED',
        'The guest must accept the liability waiver before entry.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return this.writeEntry(tx, {
      userId: dto.userId ?? null,
      entryType: 'GUEST_PASS',
      // No Payment at all — which is why Payment_amount_positive never has to
      // be relaxed for a ₱0 row.
      paymentId: null,
      // The HOST's term, whose allowance was just decremented.
      membershipId: dto.hostMembershipId,
      membershipStatusAtTime: null,
      guestWaiver:
        dto.userId === undefined
          ? {
              version: LEGAL_VERSIONS.WAIVER,
              emergencyContact: dto.guestEmergencyContact ?? null,
            }
          : null,
      guestName: dto.userId === undefined ? (dto.guestName ?? null) : null,
      guestPhone: dto.userId === undefined ? (dto.guestPhone ?? null) : null,
      guestEmail: dto.userId === undefined ? (dto.guestEmail ?? null) : null,
      operator,
      shiftId,
      now,
      today,
    });
  }

  private async writeEntry(
    tx: Prisma.TransactionClient,
    input: {
      userId: string | null;
      entryType: 'WALK_IN' | 'GUEST_PASS';
      paymentId: string | null;
      membershipId: string | null;
      membershipStatusAtTime: null;
      guestName: string | null;
      guestPhone: string | null;
      guestEmail: string | null;
      /** Set only for an account-less guest; a member's is in ConsentRecord. */
      guestWaiver: { version: string; emergencyContact: string | null } | null;
      operator: AuthUser;
      shiftId: string;
      now: Date;
      today: CivilDate;
    },
  ): Promise<CheckIn> {
    const openUserId = input.userId;

    // `skipDuplicates`, never a caught P2002: inside a transaction Postgres
    // aborts on the first statement error and Prisma issues no per-statement
    // SAVEPOINT, so a caught unique violation kills every statement after it
    // with 25P02. A member already inside who is sold a walk-in is a real
    // sequence at a counter, not a hypothetical.
    const { count } = await tx.checkIn.createMany({
      data: [
        {
          userId: input.userId,
          entryType: input.entryType,
          verdict: AccessVerdict.ALLOWED,
          membershipId: input.membershipId,
          membershipStatusAtTime: input.membershipStatusAtTime,
          paymentId: input.paymentId,
          guestName: input.guestName,
          guestPhone: input.guestPhone,
          guestEmail: input.guestEmail,
          // Version and timestamp move together — CheckIn_guest_waiver_paired.
          // The version is the SERVER's, never the caller's.
          guestWaiverVersion: input.guestWaiver?.version ?? null,
          guestWaiverAcceptedAt: input.guestWaiver === null ? null : input.now,
          guestEmergencyContact: input.guestWaiver?.emergencyContact ?? null,
          occurredAt: input.now,
          businessDate: toDateColumn(input.today),
          // NULL for an off-the-street guest: the sentinel is per-USER, and
          // somebody with no account cannot hold one.
          openUserId,
          method: 'MANUAL',
          recordedById: input.operator.id,
          shiftId: input.shiftId,
          idempotencyKey: randomUUID(),
          idempotencyHash: '0'.repeat(64),
        },
      ],
      skipDuplicates: true,
    });

    if (count === 0 && openUserId !== null) {
      // They are already inside. The SALE still stands — they paid for the
      // day — and the existing visit is what the entitlement reads from.
      const existing = await tx.checkIn.findUnique({ where: { openUserId } });
      if (existing !== null) return existing;
    }

    return tx.checkIn.findFirstOrThrow({
      where:
        openUserId === null
          ? { paymentId: input.paymentId, occurredAt: input.now }
          : { openUserId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The funnel's closing statement.
   *
   * A CONDITIONAL update on `outcome: 'UNRESOLVED'`, so a denial already
   * resolved by a manager's override is not silently re-labelled as a sale —
   * the two are different commercial outcomes and the report distinguishes
   * them.
   */
  private async resolveDenial(
    tx: Prisma.TransactionClient,
    denialId: string | undefined,
    checkInId: string,
    now: Date,
  ): Promise<void> {
    if (denialId === undefined) return;

    const { count } = await tx.checkInDenial.updateMany({
      where: { id: denialId, outcome: 'UNRESOLVED' },
      data: { outcome: 'RESOLVED_WALK_IN', resolvedByCheckInId: checkInId, resolvedAt: now },
    });

    if (count === 0) {
      const denial = await tx.checkInDenial.findUnique({ where: { id: denialId } });
      throw new DomainException(
        denial === null ? 'DENIAL_NOT_FOUND' : 'DENIAL_ALREADY_RESOLVED',
        denial === null ? 'No such denial.' : 'That denial was already dealt with.',
        denial === null ? HttpStatus.NOT_FOUND : HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  private async load(
    tx: Prisma.TransactionClient,
    checkInId: string,
    today: CivilDate,
  ): Promise<CheckInRecord> {
    const row = await tx.checkIn.findUniqueOrThrow({
      where: { id: checkInId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            memberCode: true,
            avatarUrl: true,
            status: true,
            membership: {
              include: { holds: { where: { activeMembershipId: { not: null } }, take: 1 } },
            },
          },
        },
        station: { select: { code: true, name: true } },
      },
    });

    return toCheckInRecord(row, today, {
      expiringSoonDays: this.gym.expiringSoonDays,
      graceAdmissionsMax: this.gym.graceAdmissionsMax,
    });
  }
}
