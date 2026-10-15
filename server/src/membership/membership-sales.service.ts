import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  DiscountType,
  MembershipEventType,
  MembershipStatus,
  PaymentMethod,
  PaymentPurpose,
  PlanKind,
  type Prisma,
} from '@prisma/client';
import { DiscountType as SharedDiscountType, MembershipStatus as SharedStatus } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { hashRequestBody } from '../common/idempotency/request-hash';
import {
  civilDateFromPrisma,
  gymToday,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import type { AuthUser } from '../auth/auth.types';
import { allocateMemberCode } from '../users/member-code.util';
import { PlansService } from '../catalogue/plans.service';
import { PromotionsService } from '../catalogue/promotions.service';
import { PaymentsService } from '../payments/payments.service';
import { ShiftsService } from '../payments/shifts.service';
import { MembershipService } from './membership.service';
import { assertTransition } from './membership-transitions';
import { writeMembershipEvent } from './membership-events';
import { computeAmounts, planTerm, type CurrentTerm, type PlannedTerm } from './membership-terms';
import type { MembershipDetail } from './membership.presenter';
import type { CreateMembershipDto } from './dto/create-membership.dto';
import type { RenewMembershipDto } from './dto/renew-membership.dto';

/** The money half of both DTOs, which is identical on routes 22 and 23. */
interface SaleInput {
  discountType?: DiscountType;
  discountCentavos?: number;
  statutoryIdNo?: string;
  discountReason?: string;
  /** Resolved against Promotion, then booked as an ordinary PROMO discount. */
  promoCode?: string;
  method: PaymentMethod;
  reference?: string;
  gcashVerified?: boolean;
  receiptNo?: string;
  notes?: string;
}

interface SaleContext {
  userId: string;
  membershipId: string;
  plan: { id: string; code: string; name: string; priceCentavos: number };
  termMonths: number;
  term: PlannedTerm;
  today: CivilDate;
  now: Date;
  idempotencyKey: string;
  /** The ID already held on the person, so it is not re-typed at every sale. */
  memberStatutoryIdNo: string | null;
}

/**
 * Transitions 1, 3, 4, 14 and 15 — the whole sell-and-renew surface.
 *
 * Two rules this file exists to hold:
 *
 * 1. The SERVER decides the term. `planTerm()` is pure and already tested
 *    against §5.7.3's four cases; this service does the loading and the
 *    transaction, exactly the PermissionsService / PermissionsGuard split.
 * 2. The membership row, the Payment and the MembershipEvent are ONE
 *    transaction. A sale that writes a term with no money, or money with no
 *    term, is the failure that makes an owner stop trusting the revenue figure.
 *
 * This is also the only place `allocateMemberCode()` is called on the sales
 * path, and it is called LAZILY: staff accounts never need a code, and
 * UserProvisioningService must stay a single upsert on the per-request hot path.
 *
 * Prisma's generated enums are literal unions and @got/shared's are TS enums:
 * same strings, different nominal types, so the pure helpers take one cast at
 * the boundary and the database writes use the Prisma values.
 */
@Injectable()
export class MembershipSalesService {
  private readonly logger = new Logger(MembershipSalesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly memberships: MembershipService,
    private readonly plans: PlansService,
    private readonly payments: PaymentsService,
    private readonly shifts: ShiftsService,
    private readonly promotions: PromotionsService,
  ) {}

  /** Route 22 — §5.5.2 row 1. */
  async sell(
    actor: AuthUser,
    dto: CreateMembershipDto,
    idempotencyKey: string,
    now: Date,
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: dto.userId, deletedAt: null },
        select: { id: true, memberCode: true, seniorPwdIdNo: true },
      });
      if (!user) {
        throw new DomainException(
          'MEMBER_NOT_FOUND',
          'No member with that id.',
          HttpStatus.NOT_FOUND,
        );
      }

      // One Membership row per member, forever. Checked here as well as by
      // Membership_userId_key so the desk gets the sentence, not the constraint.
      const existing = await tx.membership.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      if (existing) {
        throw new DomainException(
          'MEMBER_ALREADY_IMPORTED',
          'This member already has a membership. Renew it at POST /memberships/:id/renew.',
          HttpStatus.CONFLICT,
        );
      }

      const plan = await this.plans.requireSellable(tx, dto.planCode);
      const termMonths = this.requireTermPlan(plan);

      const term = planTerm(null, today, termMonths);
      assertTransition(null, SharedStatus.ACTIVE);

      // Lazily, inside the FIRST membership transaction. allocateMemberCode
      // probes by SELECT and returns a free code; the caller does the write,
      // because a speculative INSERT would abort this transaction (25P02).
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
          termMonths,
          graceDays: plan.graceDays,
          guestPassesPerTerm: plan.guestPassesPerTerm,
          startsOn: toDateColumn(term.startsOn),
          endsOn: toDateColumn(term.endsOn),
          billingAnchorDay: term.billingAnchorDay,
          joinedOn: toDateColumn(term.startsOn),
          graceAdmissionsThisTerm: 0,
          freezesUsedThisTerm: 0,
          guestPassesRemaining: plan.guestPassesPerTerm,
          purchasedAt: now,
        },
        select: { id: true },
      });

      const payment = await this.recordSalePayment(tx, actor, dto, {
        userId: user.id,
        membershipId: membership.id,
        plan,
        termMonths,
        term,
        today,
        now,
        idempotencyKey,
        memberStatutoryIdNo: user.seniorPwdIdNo,
      });

      await writeMembershipEvent(tx, {
        membershipId: membership.id,
        type: MembershipEventType.PURCHASED,
        fromStatus: null,
        toStatus: MembershipStatus.ACTIVE,
        // Nothing moved: there was no previous term. MembershipEvent_dates_paired
        // requires both columns null together.
        previousEndsOn: null,
        newEndsOn: null,
        reason: null,
        actorId: actor.id,
        paymentId: payment.id,
        batchRef: null,
        effectiveAt: now,
      });

      this.logger.log(
        `sold membership=${membership.id} user=${user.id} plan=${plan.code} ` +
          `term=${term.startsOn}..${term.endsOn} actor=${actor.id}`,
      );

      return this.memberships.detailById(tx, membership.id, now);
    });
  }

  /** Route 23 — §5.5.2 rows 3, 4, 14 and 15. */
  async renew(
    actor: AuthUser,
    membershipId: string,
    dto: RenewMembershipDto,
    idempotencyKey: string,
    now: Date,
  ): Promise<MembershipDetail> {
    const today = gymToday(now, this.gym.timeZone);

    return this.prisma.$transaction(async (tx) => {
      const membership = await this.memberships.loadForUpdate(tx, membershipId);

      // §5.5.3. Refused HERE and not in the transition table, because
      // FROZEN -> ACTIVE is legitimate (row 9, early release) and the table
      // cannot tell the two apart. Unfreeze first, so the freeze extension
      // arithmetic never has two writers.
      if (membership.status === MembershipStatus.FROZEN) {
        throw new DomainException(
          'MEMBERSHIP_NOT_ACTIVE',
          'Unfreeze this membership before renewing it.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      const user = await tx.user.findUniqueOrThrow({
        where: { id: membership.userId },
        select: { seniorPwdIdNo: true },
      });

      const plan = await this.plans.requireSellable(tx, dto.planCode);
      const termMonths = this.requireTermPlan(plan);

      const current: CurrentTerm = {
        status: membership.status as unknown as SharedStatus,
        endsOn: civilDateFromPrisma(membership.endsOn),
        graceDays: membership.graceDays,
        billingAnchorDay: membership.billingAnchorDay,
      };
      const term = planTerm(current, today, termMonths);
      assertTransition(membership.status as unknown as SharedStatus, SharedStatus.ACTIVE);

      const graceAdmissions = await this.openingGraceAdmissions(tx, membershipId, term);
      const previousEndsOn = current.endsOn;

      await tx.membership.update({
        where: { id: membershipId },
        data: {
          planId: plan.id,
          status: MembershipStatus.ACTIVE,
          // Snapshots refreshed: the NEW term's commercial terms, not the old.
          planCode: plan.code,
          planName: plan.name,
          planPriceCentavos: plan.priceCentavos,
          termMonths,
          graceDays: plan.graceDays,
          guestPassesPerTerm: plan.guestPassesPerTerm,
          startsOn: toDateColumn(term.startsOn),
          endsOn: toDateColumn(term.endsOn),
          billingAnchorDay: term.billingAnchorDay,
          // Membership_cancel_shape is biconditional, so reactivating from
          // CANCELLED must clear cancelledOn in the same statement.
          cancelRequestedOn: null,
          cancelledOn: null,
          // Per-term counters, all reset (§5.3.3).
          graceAdmissionsThisTerm: graceAdmissions,
          freezesUsedThisTerm: 0,
          guestPassesRemaining: plan.guestPassesPerTerm,
          purchasedAt: now,
        },
      });

      const payment = await this.recordSalePayment(tx, actor, dto, {
        userId: membership.userId,
        membershipId,
        plan,
        termMonths,
        term,
        today,
        now,
        idempotencyKey,
        memberStatutoryIdNo: user.seniorPwdIdNo,
      });

      await writeMembershipEvent(tx, {
        membershipId,
        // A restart is not a renewal, and churn reporting depends on the
        // distinction (§5.7.3).
        type:
          term.kind === 'REACTIVATION'
            ? MembershipEventType.REACTIVATED
            : MembershipEventType.RENEWED,
        fromStatus: membership.status,
        toStatus: MembershipStatus.ACTIVE,
        previousEndsOn,
        newEndsOn: term.endsOn,
        reason: term.kind === 'RENEWAL_IN_GRACE' ? 'in grace' : null,
        actorId: actor.id,
        paymentId: payment.id,
        batchRef: null,
        effectiveAt: now,
      });

      this.logger.log(
        `renewed membership=${membershipId} kind=${term.kind} plan=${plan.code} ` +
          `term=${term.startsOn}..${term.endsOn} grace=${graceAdmissions} actor=${actor.id}`,
      );

      return this.memberships.detailById(tx, membershipId, now);
    });
  }

  /**
   * A WALK_IN plan prices a single day's entry and never creates or extends a
   * membership. Reported as PLAN_NOT_FOUND rather than a new code: from route
   * 22's point of view there IS no term plan with that code, and the message
   * says which mistake was made.
   */
  private requireTermPlan(plan: {
    code: string;
    kind: PlanKind;
    termMonths: number | null;
  }): number {
    if (plan.kind !== PlanKind.TERM || plan.termMonths === null) {
      throw new DomainException(
        'PLAN_NOT_FOUND',
        `${plan.code} prices a single day's entry, not a term — there is no term plan with that code.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return plan.termMonths;
  }

  /**
   * §5.4.3's un-farmable-grace rule.
   *
   * A term settled inside grace opens with NO grace of its own when the term
   * before it was ALSO settled late. Without it a Monthly member trains three
   * free days every cycle, forever.
   *
   * "Settled late" is read off the ledger rather than recomputed: the most
   * recent RENEWED event whose previousEndsOn was already behind the gym-local
   * day that event took effect on.
   */
  private async openingGraceAdmissions(
    tx: Prisma.TransactionClient,
    membershipId: string,
    term: PlannedTerm,
  ): Promise<number> {
    if (term.kind !== 'RENEWAL_IN_GRACE') return 0;

    const previous = await tx.membershipEvent.findFirst({
      where: {
        membershipId,
        type: MembershipEventType.RENEWED,
        previousEndsOn: { not: null },
      },
      orderBy: { effectiveAt: 'desc' },
      select: { previousEndsOn: true, effectiveAt: true },
    });
    if (!previous || previous.previousEndsOn === null) return 0;

    const settledOn = gymToday(previous.effectiveAt, this.gym.timeZone);
    const lapsedThatTimeToo = civilDateFromPrisma(previous.previousEndsOn) < settledOn;
    return lapsedThatTimeToo ? this.gym.graceAdmissionsMax : 0;
  }

  /**
   * The money half, identical on both routes.
   *
   * Every rule checked here is ALSO a CHECK constraint on Payment. The service
   * check is the user-facing path and the constraint is the backstop, so a
   * constraint firing is a bug report rather than a 500 the console cannot
   * branch on.
   */
  private async recordSalePayment(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    input: SaleInput,
    context: SaleContext,
  ): Promise<{ id: string }> {
    /*
     * ─────────────────────────────────────────────────────────────────────
     * A PROMO CODE IS A DISCOUNT TYPE, NOT A PARALLEL PATH.
     *
     * Resolving it here — before the permission check, before the shape
     * check, before computeAmounts — means a redeemed promotion is an
     * ordinary PROMO payment from this line onward. It obeys
     * Payment_discount_shape, appears in the discount report, and needs no
     * special case in reconciliation.
     *
     * STATUTORY WINS. A senior or PWD presenting a promo code gets their
     * RA 9994 / RA 10754 entitlement instead: it is a legal right rather
     * than an offer, and it is worth more than any promo this gym would run.
     * `discountType` is one column, so the two can never both apply.
     * ─────────────────────────────────────────────────────────────────────
     */
    const promoCode = input.promoCode?.trim() ?? '';
    const requestedType = input.discountType ?? DiscountType.NONE;
    const statutoryRequested =
      requestedType === DiscountType.SENIOR || requestedType === DiscountType.PWD;

    const promotion =
      promoCode !== '' && !statutoryRequested
        ? await this.promotions.quote(
            promoCode,
            {
              code: context.plan.code,
              kind: 'TERM',
              priceCentavos: context.plan.priceCentavos,
            },
            context.today,
            tx,
          )
        : null;

    const discountType = promotion === null ? requestedType : DiscountType.PROMO;

    // One @RequirePermission key per route, so the discount split is an
    // in-service check against the caller's resolved permissions, never a
    // second decorator (§5.11).
    await this.payments.assertDiscountAllowed(actor, discountType as unknown as SharedDiscountType);

    const statutory = discountType === DiscountType.SENIOR || discountType === DiscountType.PWD;
    const statutoryIdNo = statutory
      ? (input.statutoryIdNo?.trim() ?? context.memberStatutoryIdNo?.trim() ?? '')
      : '';
    if (statutory && statutoryIdNo.length === 0) {
      throw new DomainException(
        'STATUTORY_ID_REQUIRED',
        'A senior or PWD discount requires the OSCA / PWD ID number. BIR keeps this register separately.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const discretionary = discountType !== DiscountType.NONE && !statutory;
    // A promotion supplies its own reason — "PROMO SUMMER20 — Summer sale" —
    // so the discount report names the campaign without joining back.
    const discountReason = promotion !== null
      ? promotion.reason
      : discretionary
        ? (input.discountReason?.trim() ?? '')
        : '';
    if (discretionary && discountReason.length < 3) {
      throw new DomainException(
        'DISCOUNT_ID_REQUIRED',
        `A ${discountType} discount requires a reason of at least three characters.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const reference = input.reference?.trim() ?? '';
    if (input.method === PaymentMethod.GCASH && reference.length === 0) {
      throw new DomainException(
        'GCASH_REFERENCE_REQUIRED',
        'A GCash payment with no reference cannot be reconciled against the statement.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const amounts = computeAmounts({
      priceCentavos: context.plan.priceCentavos,
      discountType: discountType as unknown as SharedDiscountType,
      vatRegistered: this.gym.vatRegistered,
      // Staff never type an amount for a statutory discount (§5.7.4): the
      // statute fixes it, so anything sent is discarded rather than trusted.
      // A promotion's amount comes from the campaign, never from the request:
      // a caller that could name its own promo discount could name any number.
      operatorDiscountCentavos:
        promotion !== null
          ? promotion.discountCentavos
          : discretionary
            ? (input.discountCentavos ?? 0)
            : 0,
    });

    // Inside the sale's transaction, so an abandoned or failed sale cannot
    // spend a redemption. Conditional UPDATE — see PromotionsService.redeem.
    if (promotion !== null) await this.promotions.redeem(tx, promotion.code);

    // Held on the person, not re-typed at every sale (§5.3.1).
    if (statutory && statutoryIdNo !== (context.memberStatutoryIdNo ?? '')) {
      await tx.user.update({
        where: { id: context.userId },
        data: { seniorPwdIdNo: statutoryIdNo },
      });
    }

    // Payment.shiftId is NOT NULL and stays that way: money without a counted
    // drawer is exactly what cannot be reconciled later.
    const shiftId = await this.shifts.requireOpenShiftId(tx);

    return this.payments.createInTx(tx, {
      userId: context.userId,
      membershipId: context.membershipId,
      planId: context.plan.id,
      planCode: context.plan.code,
      planName: context.plan.name,
      purpose: PaymentPurpose.MEMBERSHIP,
      amounts,
      discountType,
      statutoryIdNo: statutory ? statutoryIdNo : null,
      discountReason: discretionary ? discountReason : null,
      termMonths: context.termMonths,
      termStartsOn: context.term.startsOn,
      termEndsOn: context.term.endsOn,
      method: input.method,
      reference: reference.length > 0 ? reference : null,
      gcashVerified: input.gcashVerified ?? false,
      receiptNo: input.receiptNo?.trim() ?? null,
      receivedAt: context.now,
      businessDate: context.today,
      shiftId,
      recordedById: actor.id,
      // The header value, stored on the row as well as on IdempotencyRecord.
      // The interceptor's hash over the RAW body is what decides a replay; this
      // one is the row-level fingerprint an auditor reads six months later.
      idempotencyKey: context.idempotencyKey,
      idempotencyHash: hashRequestBody(input),
      notes: input.notes?.trim() ?? null,
    });
  }
}
