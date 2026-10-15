import { ForbiddenException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  type DiscountType as PrismaDiscountType,
  type Payment,
  type PaymentMethod as PrismaPaymentMethod,
  type PaymentPurpose as PrismaPaymentPurpose,
  PaymentStatus,
} from '@prisma/client';
import { DiscountType, PaymentPurpose, PlanKind } from '@got/shared';
import type { PaginatedData } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GymConfigService } from '../config/gym.config';
import { PermissionsService } from '../rbac/permissions.service';
import type { PermissionUser } from '../rbac/rbac.types';
import type { ScopedWhere } from '../rbac/scope.util';
import { DomainException } from '../common/exceptions/domain.exception';
import { mapPrismaError } from '../common/exceptions/prisma-error.mapper';
import { assertConfirmed } from '../common/dto/confirm.dto';
import { hashRequestBody } from '../common/idempotency/request-hash';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import {
  civilDateFromPrisma,
  gymToday,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import type { AuthUser } from '../auth/auth.types';
import { PlansService } from '../catalogue/plans.service';
import { computeAmounts, type Amounts } from '../membership/membership-terms';
import { ShiftsService } from './shifts.service';
import { normalizeGcashReference } from './payment-reference';
import { toReceiptDoc, type ReceiptDoc } from './receipt.presenter';
import { toPaymentSummary, type PaymentSummary } from './payment.presenter';
import { toPaymentDetail, type PaymentDetail } from './payment-detail.presenter';
import type { RecordPaymentDto } from './dto/record-payment.dto';
import type { VoidPaymentDto } from './dto/void-payment.dto';
import type { AmendPaymentDto } from './dto/amend-payment.dto';
import type { ListPaymentsQueryDto } from './dto/list-payments-query.dto';

/** Everything the one Payment INSERT in this codebase needs. Prisma enums. */
export interface CreatePaymentInput {
  userId: string | null;
  membershipId: string | null;
  planId: string;
  planCode: string;
  planName: string;
  purpose: PrismaPaymentPurpose;
  amounts: Amounts;
  discountType: PrismaDiscountType;
  statutoryIdNo: string | null;
  discountReason: string | null;
  termMonths: number | null;
  termStartsOn: CivilDate | null;
  termEndsOn: CivilDate | null;
  method: PrismaPaymentMethod;
  reference: string | null;
  /**
   * Staff opened the gym's own GCash Transactions tab and saw this payment.
   * A boolean, deliberately — there is no image (see payment.prisma's model
   * comment). Ignored unless method is GCASH.
   */
  gcashVerified: boolean;
  receiptNo: string | null;
  receivedAt: Date;
  businessDate: CivilDate;
  shiftId: string;
  recordedById: string;
  idempotencyKey: string;
  idempotencyHash: string;
  notes: string | null;
  /**
   * The payment this one corrects, for an amend. Optional and defaulting to
   * null so every existing caller is untouched — a fresh sale replaces
   * nothing.
   */
  replacesPaymentId?: string | null;
}

export type PaymentListResult = PaginatedData<PaymentSummary> & {
  totalCentavos: number;
  byMethod: { CASH: number; GCASH: number };
};

/** Which key a discount type demands, beyond the route's own payment.record. */
const DISCOUNT_PERMISSION: Readonly<Record<DiscountType, string | null>> = {
  [DiscountType.NONE]: null,
  [DiscountType.SENIOR]: 'payment.discount.statutory',
  [DiscountType.PWD]: 'payment.discount.statutory',
  [DiscountType.PROMO]: 'payment.discount.grant',
  [DiscountType.STAFF]: 'payment.discount.grant',
  [DiscountType.GUEST_PASS]: 'payment.discount.grant',
  [DiscountType.GOODWILL]: 'payment.discount.grant',
};

const COMP_TYPES: readonly DiscountType[] = [
  DiscountType.PROMO,
  DiscountType.STAFF,
  DiscountType.GUEST_PASS,
  DiscountType.GOODWILL,
];

/**
 * An amend's three-way field resolution: sent → use it, `''` → CLEAR it,
 * omitted → inherit the original.
 *
 * The empty string is the only way an operator can say "there is no booklet
 * number after all"; `undefined` cannot express it, because `undefined` is
 * also what every untouched field sends.
 */
function blank(sent: string | undefined, inherited: string | null): string | null {
  if (sent === undefined) return inherited;
  return sent.trim() === '' ? null : sent;
}

/**
 * The small `{ before, after }` slice an amend's audit entry carries.
 *
 * Seven fields, chosen because they are what somebody reading the trail is
 * trying to answer: how much, how paid, for what, to whom. NEVER the whole
 * row — an audit log that stores full records is a second copy of the
 * database with none of its constraints.
 */
function changeShape(row: Payment): Record<string, string | number | null> {
  return {
    netCentavos: row.netCentavos,
    method: row.method,
    planCode: row.planCode,
    discountType: row.discountType,
    reference: row.reference,
    receiptNo: row.receiptNo,
    userId: row.userId,
  };
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly permissions: PermissionsService,
    private readonly plans: PlansService,
    private readonly shifts: ShiftsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The second permission check on a money route, and deliberately NOT a second
   * decorator: `@RequirePermission` resolves with getAllAndOverride, so a
   * method-level key REPLACES a class-level one and a route can carry exactly
   * one. POST /payments carries payment.record; the discount keys are resolved
   * here, against the same PermissionsService the guard uses.
   *
   * SENIOR and PWD sit under payment.discount.statutory, which FRONT_DESK holds
   * at ALL: RA 9994 / RA 10754 make the discount mandatory and refusing it a
   * criminal offence, so it must not need a manager. The discretionary types
   * stay ADMIN-only under payment.discount.grant.
   */
  async assertDiscountAllowed(user: PermissionUser, discountType: DiscountType): Promise<void> {
    const required = DISCOUNT_PERMISSION[discountType];
    if (required === null) return;

    const held = await this.permissions.getEffectivePermissions(user);
    if (!held.some((permission) => permission.key === required)) {
      // Same shape PermissionsGuard throws, so the console branches once.
      throw new ForbiddenException(`Missing required permission: ${required}`);
    }
  }

  async record(
    actor: AuthUser,
    dto: RecordPaymentDto,
    idempotencyKey: string,
    now: Date,
  ): Promise<PaymentSummary> {
    if (dto.purpose !== PaymentPurpose.WALK_IN) {
      throw new DomainException(
        'PAYMENT_SHAPE_INVALID',
        'This endpoint records a walk-in. A membership term is sold through ' +
          'POST /memberships or /memberships/:id/renew, and a freeze fee through ' +
          'POST /memberships/:id/freeze — each writes its Payment inside the same ' +
          'transaction as the row it pays for.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const discountType = dto.discountType ?? DiscountType.NONE;
    await this.assertDiscountAllowed(actor, discountType);
    this.assertDiscountShape(discountType, dto.statutoryIdNo, dto.discountReason);

    const receivedAt = dto.receivedAt === undefined ? now : new Date(dto.receivedAt);
    // Derived, never sent: a client-chosen business day would let one sale be
    // attributed to a till report it was not in.
    const businessDate = gymToday(receivedAt, this.gym.timeZone);

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const plan = await this.plans.requireSellable(tx, dto.planCode);
        if ((plan.kind as unknown as PlanKind) !== PlanKind.WALK_IN) {
          throw new DomainException(
            'PAYMENT_SHAPE_INVALID',
            `${plan.code} is a term plan and is sold through POST /memberships.`,
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        if (dto.grossCentavos !== plan.priceCentavos) {
          throw new DomainException(
            'PAYMENT_AMOUNT_MISMATCH',
            `${plan.code} is ${plan.priceCentavos} centavos, not ${dto.grossCentavos}. ` +
              'Reload the price list before ringing this sale.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        const amounts = computeAmounts({
          priceCentavos: plan.priceCentavos,
          discountType,
          vatRegistered: this.gym.vatRegistered,
          ...(dto.discountCentavos === undefined
            ? {}
            : { operatorDiscountCentavos: dto.discountCentavos }),
        });

        if (dto.netCentavos !== undefined && dto.netCentavos !== amounts.netCentavos) {
          throw new DomainException(
            'PAYMENT_AMOUNT_MISMATCH',
            `The collected amount should be ${amounts.netCentavos} centavos, ` +
              `not ${dto.netCentavos}.`,
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        if (amounts.netCentavos === 0 && !COMP_TYPES.includes(discountType)) {
          throw new DomainException(
            'PAYMENT_AMOUNT_MISMATCH',
            'A ₱0 collection is only legal as a comp — PROMO, STAFF, GUEST_PASS or GOODWILL.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        if (dto.userId !== undefined) {
          const member = await tx.user.findFirst({
            where: { id: dto.userId, deletedAt: null },
            select: { id: true },
          });
          if (member === null) {
            throw new DomainException(
              'MEMBER_NOT_FOUND',
              'That member does not exist.',
              HttpStatus.NOT_FOUND,
            );
          }
        }

        const shiftId = await this.shifts.requireOpenShiftId(tx);

        return this.createInTx(tx, {
          userId: dto.userId ?? null,
          membershipId: null,
          planId: plan.id,
          planCode: plan.code,
          planName: plan.name,
          purpose: 'WALK_IN',
          amounts,
          discountType: discountType,
          statutoryIdNo: dto.statutoryIdNo ?? null,
          discountReason: dto.discountReason ?? null,
          termMonths: null,
          termStartsOn: null,
          termEndsOn: null,
          method: dto.method,
          reference: dto.reference ?? null,
          gcashVerified: dto.gcashVerified ?? false,
          receiptNo: dto.receiptNo ?? null,
          receivedAt,
          businessDate,
          shiftId,
          recordedById: actor.id,
          idempotencyKey,
          idempotencyHash: hashRequestBody(dto),
          notes: dto.notes ?? null,
        });
      });

      return toPaymentSummary(row);
    } catch (error) {
      // Caught AFTER the whole $transaction call has rejected, so nothing
      // further touches `tx` and the §4.6(d) rule is not violated.
      const mapped = mapPrismaError(error);
      if (mapped) throw mapped;
      throw error;
    }
  }

  /**
   * The one INSERT into Payment. Membership sales (task 12) and the freeze fee
   * (task 14) reuse it so the GCash rule, the idempotency claim and the money
   * columns exist once.
   *
   * The claim is createMany({ skipDuplicates: true }) — INSERT … ON CONFLICT DO
   * NOTHING — and never a caught P2002, because inside $transaction Postgres
   * aborts on the first statement error and every later statement dies with
   * 25P02. On count === 0 the transaction is still alive and the stored row can
   * be read on the same tx.
   *
   * On the HTTP path @Idempotent() has usually already replayed the request, so
   * this branch mostly serves the INTERNAL callers, whose keys are derived from
   * the row that caused the payment (`freeze:<holdId>`) rather than a header.
   */
  async createInTx(tx: Prisma.TransactionClient, input: CreatePaymentInput): Promise<Payment> {
    if (input.method === 'GCASH' && (input.reference === null || input.reference.trim() === '')) {
      throw new DomainException(
        'GCASH_REFERENCE_REQUIRED',
        'A GCash payment needs the reference from the member’s screen — without it ' +
          'the row cannot be reconciled against the monthly statement.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Above the threshold, the attestation is REQUIRED, not merely offered.
    // Unset threshold = never required — the ₱90 day pass must not grow
    // thirty seconds of counter friction, while a multi-month membership is
    // exactly the amount the fake-screenshot scam is aimed at.
    const threshold = this.gym.gcashVerifyThresholdCentavos;
    if (
      input.method === 'GCASH' &&
      threshold !== null &&
      input.amounts.netCentavos >= threshold &&
      !input.gcashVerified
    ) {
      throw new DomainException(
        'GCASH_VERIFICATION_REQUIRED',
        "Open the gym's GCash Transactions tab and confirm this payment is there " +
          'before recording it.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const referenceNormalized =
      input.reference === null ? null : normalizeGcashReference(input.reference);
    const verified = input.method === 'GCASH' && input.gcashVerified;

    const { count } = await tx.payment.createMany({
      data: [
        {
          userId: input.userId,
          membershipId: input.membershipId,
          planId: input.planId,
          purpose: input.purpose,
          planCode: input.planCode,
          planName: input.planName,
          grossCentavos: input.amounts.grossCentavos,
          vatBaseCentavos: input.amounts.vatBaseCentavos,
          discountType: input.discountType,
          discountCentavos: input.amounts.discountCentavos,
          netCentavos: input.amounts.netCentavos,
          vatExempt: input.amounts.vatExempt,
          statutoryIdNo: input.statutoryIdNo,
          discountReason: input.discountReason,
          termMonths: input.termMonths,
          termStartsOn: input.termStartsOn === null ? null : toDateColumn(input.termStartsOn),
          termEndsOn: input.termEndsOn === null ? null : toDateColumn(input.termEndsOn),
          method: input.method,
          reference: input.reference,
          referenceNormalized,
          // The pair moves together (Payment_gcash_verified_shape), written
          // at INSERT only.
          gcashVerifiedAt: verified ? input.receivedAt : null,
          gcashVerifiedById: verified ? input.recordedById : null,
          receiptNo: input.receiptNo,
          // Not independent information: a receipt is issued exactly when its
          // number is recorded, so deriving it here is the only way the flag
          // and the number cannot disagree.
          receiptIssued: input.receiptNo !== null,
          receivedAt: input.receivedAt,
          businessDate: toDateColumn(input.businessDate),
          shiftId: input.shiftId,
          recordedById: input.recordedById,
          idempotencyKey: input.idempotencyKey,
          idempotencyHash: input.idempotencyHash,
          notes: input.notes,
          replacesPaymentId: input.replacesPaymentId ?? null,
        },
      ],
      skipDuplicates: true,
    });

    const stored = await tx.payment.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });

    if (stored === null) {
      // createMany({skipDuplicates}) is ON CONFLICT DO NOTHING with NO
      // conflict target — it swallows EVERY unique violation, and the only
      // other unique index on this table is Payment_gcash_reference_unique.
      // So: this reference is already recorded against a live payment. Legal
      // to keep querying: a suppressed conflict is not a statement error, the
      // transaction is alive, and the §4.6(d) 25P02 rule is about CAUGHT
      // violations. Name the earlier row — the desk must tell "I already
      // rang this one" apart from "this member is showing me a recycled
      // receipt".
      const earlier = await tx.payment.findFirst({
        where: { referenceNormalized, method: 'GCASH', status: { not: 'VOIDED' } },
        select: { businessDate: true, netCentavos: true },
      });
      throw new DomainException(
        'GCASH_REFERENCE_DUPLICATE',
        earlier === null
          ? 'A live GCash payment already carries this reference.'
          : `A live GCash payment already carries this reference — recorded ` +
            `${civilDateFromPrisma(earlier.businessDate)} for ${earlier.netCentavos} centavos. ` +
            'If that one was mis-keyed, void it first.',
        HttpStatus.CONFLICT,
      );
    }

    if (count === 0 && stored.idempotencyHash !== input.idempotencyHash) {
      // A stale 200 for a different body hands back the ₱90 receipt while the
      // desk believes ₱8,000 was recorded — worse than no idempotency at all,
      // because it is silent and looks like success.
      throw new DomainException(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different payment.',
        HttpStatus.CONFLICT,
      );
    }

    return stored;
  }

  /**
   * The Transaction Slip's data. `recordedBy` is included because a slip
   * signed "Recorded by a3f1c9d2…" is unusable — PaymentSummary only ever
   * carries the raw uuid (payment.presenter), and the daily report already
   * demonstrates the include.
   */
  async receipt(id: string, now: Date): Promise<ReceiptDoc> {
    const row = await this.prisma.payment.findUnique({
      where: { id },
      include: {
        user: { select: { firstName: true, lastName: true, memberCode: true } },
        recordedBy: { select: { firstName: true, lastName: true } },
      },
    });
    if (row === null) {
      throw new DomainException(
        'PAYMENT_NOT_FOUND',
        'That payment does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    return toReceiptDoc(
      row,
      {
        registeredName: this.gym.registeredName,
        tradeName: this.gym.tradeName,
        address: this.gym.registeredAddress,
        tin: this.gym.tin,
        vatRegistered: this.gym.vatRegistered,
      },
      now,
    );
  }

  async list(
    query: ListPaymentsQueryDto,
    scope: ScopedWhere<Prisma.PaymentWhereInput>,
  ): Promise<PaymentListResult> {
    const filters: Prisma.PaymentWhereInput = {
      ...(query.method ? { method: query.method } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.discountType ? { discountType: query.discountType } : {}),
      ...(query.shiftId ? { shiftId: query.shiftId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.planCode ? { planCode: query.planCode } : {}),
      // Archived rows are a SOFT DELETE: excluded by default, and
      // `?archived=true` shows ONLY them. It is a VIEW, not a widening —
      // "hide" and "show" are two disjoint lists rather than one list that
      // sometimes grows, which is what keeps the register's totals legible.
      //
      // The TOTALS below inherit this filter, and that is a DISPLAY total for
      // the current view, not a revenue figure. Nothing in ReportsService,
      // ShiftsService or the BIR register reads `archivedAt` — see the
      // model comment on Payment.archivedAt.
      archivedAt: query.archived ? { not: null } : null,
      ...(query.from === undefined && query.to === undefined
        ? {}
        : {
            businessDate: {
              ...(query.from === undefined ? {} : { gte: toDateColumn(query.from) }),
              ...(query.to === undefined ? {} : { lte: toDateColumn(query.to) }),
            },
          }),
    };

    // AND, never spread. `scope` can carry a top-level OR (a COACH at OWN
    // reaches assigned members through the user relation) and spreading would
    // clobber it — which is what the ScopedWhere brand makes a compile error.
    const where: Prisma.PaymentWhereInput = { AND: [filters, scope] };
    const recorded: Prisma.PaymentWhereInput = {
      AND: [filters, scope, { status: PaymentStatus.RECORDED }],
    };

    const [rows, total, sum, byMethodRows] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        // The join that turns a raw uuid into a name on the payments screen.
        include: { user: { select: { firstName: true, lastName: true } } },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        ...paginationSkipTake(query),
      }),
      this.prisma.payment.count({ where }),
      this.prisma.payment.aggregate({ where: recorded, _sum: { netCentavos: true } }),
      this.prisma.payment.groupBy({
        by: ['method'],
        where: recorded,
        _sum: { netCentavos: true },
        orderBy: { method: 'asc' },
      }),
    ]);

    // A void is not money. Totals cover RECORDED rows only; the voided rows
    // stay in `items` because the drawer still has to explain them.
    const byMethod = { CASH: 0, GCASH: 0 };
    for (const group of byMethodRows) {
      byMethod[group.method] = group._sum?.netCentavos ?? 0;
    }

    return {
      ...paginated(rows.map(toPaymentSummary), total, query),
      totalCentavos: sum._sum.netCentavos ?? 0,
      byMethod,
    };
  }

  /**
   * The member's own history, for the keyless /me/payments route (task 11).
   *
   * The cast is the one place in this service a scope is asserted rather than
   * resolved, and it is safe for exactly one reason: the userId is hard-coded
   * from `request.user`, never from a parameter. That is also why CLIENT is
   * granted no payment.read at all — OWN never has to mean two different things
   * depending on who is asking.
   */
  async listForMember(userId: string, query: ListPaymentsQueryDto): Promise<PaymentListResult> {
    return this.list(query, { userId } as ScopedWhere<Prisma.PaymentWhereInput>);
  }

  async void(actor: AuthUser, id: string, dto: VoidPaymentDto, now: Date): Promise<PaymentSummary> {
    assertConfirmed(dto);

    const existing = await this.prisma.payment.findUnique({ where: { id } });
    if (existing === null) {
      throw new DomainException('PAYMENT_NOT_FOUND', 'Payment not found', HttpStatus.NOT_FOUND);
    }
    if (existing.status === PaymentStatus.VOIDED) {
      throw new DomainException(
        'PAYMENT_ALREADY_VOIDED',
        `This payment was already voided on ${civilDateFromPrisma(existing.businessDate)}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Guarded UPDATE: two simultaneous voids, one winner, and the loser reads
    // count 0 rather than overwriting the first void's reason and actor.
    const claimed = await this.prisma.payment.updateMany({
      where: { id, status: PaymentStatus.RECORDED },
      data: {
        status: PaymentStatus.VOIDED,
        voidedAt: now,
        voidedById: actor.id,
        voidReason: dto.reason,
        voidKind: dto.kind,
      },
    });
    if (claimed.count !== 1) {
      throw new DomainException(
        'PAYMENT_ALREADY_VOIDED',
        'This payment was voided by someone else a moment ago.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Voiding does NOT roll back the membership it bought — that is a separate,
    // deliberate cancel (§5.7.6).
    const row = await this.prisma.payment.findUniqueOrThrow({ where: { id } });

    // AFTER the guarded UPDATE claimed the void, so exactly one entry is
    // written no matter how many operators pressed the button. `record` never
    // throws — see its header for why a failed log must not undo a void the
    // desk has already told the member about.
    await this.audit.record(
      {
        action: 'PAYMENT_VOIDED',
        actorId: actor.id,
        actorRole: actor.role,
        subjectType: 'Payment',
        subjectId: row.id,
        // The receipt number if one was issued, else the GCash reference —
        // the two things a person can look up. The uuid last, so the line
        // still identifies something rather than reading as a blank.
        subjectLabel: row.receiptNo ?? row.reference ?? row.id,
        reason: dto.reason,
        details: { kind: dto.kind, netCentavos: row.netCentavos, method: row.method },
      },
      now,
    );

    return toPaymentSummary(row);
  }

  /**
   * "Edit payment" — ONE transaction that VOIDS the original and writes a
   * corrected replacement in its place, linked by `replacesPaymentId`.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * IT IS NOT A PATCH, AND THE REGISTER KEEPS BOTH ROWS.
   *
   * The alternative — an UPDATE that rewrites the figure — rewrites a number
   * a member may be holding a printed slip for, and leaves the till report
   * for a day that has already been counted disagreeing with the paper in
   * the drawer with nothing to explain the difference.
   *
   * THE REPLACEMENT LANDS IN THE ORIGINAL'S SHIFT, CLOSED OR NOT, and
   * `requireOpenShiftId` is deliberately never called. That guard exists
   * because NEW money entering the building must land in a counted drawer.
   * An amend moves no money — it restates a row whose cash was already
   * counted in the shift it names. Attributing Tuesday's corrected ₱800 to
   * Thursday's open drawer would put money in a box it was never in and make
   * BOTH days wrong.
   *
   * SAY THE CONSEQUENCE OUT LOUD: a closed shift's `expectedCentavos` /
   * `countedCentavos` / `varianceCentavos` are snapshots taken at close and
   * are never recomputed, so after an amend they no longer equal
   * `openingFloat + SUM(net)` over the shift's current rows. That is
   * correct — they record what was expected WHEN THE DRAWER WAS PHYSICALLY
   * COUNTED. This is already true of `void()` today; amend does not
   * introduce it. The drawer says so to the operator, and so does the audit
   * entry's `shiftWasClosed`.
   *
   * NOT @Idempotent(), same reasoning as void(): a second amend is a 422 the
   * console must see, not a replayed 200 that pretends it worked. The
   * row-level `idempotencyKey: amend:<id>` still makes a double-submit of
   * the same body a true replay.
   * ═══════════════════════════════════════════════════════════════════════
   */
  async amend(
    actor: AuthUser,
    id: string,
    dto: AmendPaymentDto,
    now: Date,
  ): Promise<PaymentSummary> {
    assertConfirmed(dto);

    // Read once OUTSIDE the transaction, only to resolve the discount: the
    // permission check below queries the RBAC tables, and a permission lookup
    // held inside a money transaction keeps a row lock open for the duration
    // of a cache miss. The authoritative read happens on `tx`.
    const preload = await this.prisma.payment.findUnique({ where: { id } });
    if (preload === null) {
      throw new DomainException('PAYMENT_NOT_FOUND', 'Payment not found', HttpStatus.NOT_FOUND);
    }

    const discountType = (dto.discountType ??
      (preload.discountType as unknown as DiscountType)) as DiscountType;
    await this.assertDiscountAllowed(actor, discountType);
    this.assertDiscountShape(
      discountType,
      blank(dto.statutoryIdNo, preload.statutoryIdNo) ?? undefined,
      blank(dto.discountReason, preload.discountReason) ?? undefined,
    );

    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const original = await tx.payment.findUnique({
          where: { id },
          include: {
            // The back reference on the ONE stored column — there is no
            // second column to disagree with it.
            replacedBy: { select: { id: true } },
            shift: { select: { closedAt: true } },
          },
        });
        if (original === null) {
          throw new DomainException('PAYMENT_NOT_FOUND', 'Payment not found', HttpStatus.NOT_FOUND);
        }
        if (original.status !== PaymentStatus.RECORDED) {
          throw new DomainException(
            'PAYMENT_ALREADY_VOIDED',
            `This payment was already voided on ${civilDateFromPrisma(original.businessDate)}. ` +
              'A voided row is the record of what happened; record the correct sale instead.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        if (original.replacedBy !== null) {
          throw new DomainException(
            'PAYMENT_ALREADY_AMENDED',
            'This payment has already been corrected. Open the correction and amend that.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        if (dto.userId !== undefined && original.purpose !== 'WALK_IN') {
          throw new DomainException(
            'PAYMENT_PAYER_IMMUTABLE',
            'Only a walk-in payment can be moved to a different payer — a membership or ' +
              'freeze fee is attached to the term it paid for.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        /*
         * ─── 1. VOID FIRST. THE ORDERING IS LOAD-BEARING. ───────────────
         *
         * `Payment_gcash_reference_unique` is partial:
         *   ON ("referenceNormalized") WHERE method='GCASH' AND status<>'VOIDED'
         * Voiding the original HERE, inside this transaction, removes it from
         * that predicate — which is the only reason the corrected row may
         * carry the SAME reference. Insert first and every amend of a GCash
         * payment whose reference is not changing fails on the index.
         *
         * The guarded updateMany is also the concurrency control: two
         * operators, one winner, and the loser reads count 0 rather than
         * overwriting the first amend.
         */
        const claimed = await tx.payment.updateMany({
          where: { id, status: PaymentStatus.RECORDED },
          data: {
            status: PaymentStatus.VOIDED,
            voidedAt: now,
            voidedById: actor.id,
            voidReason: `Amended — ${dto.reason}`,
            voidKind: 'VOID',
          },
        });
        if (claimed.count !== 1) {
          throw new DomainException(
            'PAYMENT_ALREADY_VOIDED',
            'This payment was voided by someone else a moment ago.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        // ─── 2. Re-resolve the plan ONLY when it changed ────────────────
        // so amending a sale on a since-archived or since-repriced plan
        // neither fails nor silently reprices.
        const plan =
          dto.planCode !== undefined && dto.planCode !== original.planCode
            ? await this.plans.requireSellable(tx, dto.planCode)
            : null;

        // ─── 3. Re-derive money with the SAME function a fresh sale uses ──
        // The operator discount INHERITS, like every other omitted field: a
        // method-only amend of a PROMO sale must not silently zero the
        // discount and raise the net.
        const operatorDiscountCentavos = dto.discountCentavos ?? original.discountCentavos;
        const amounts = computeAmounts({
          priceCentavos: plan?.priceCentavos ?? original.grossCentavos,
          discountType,
          vatRegistered: this.gym.vatRegistered,
          operatorDiscountCentavos,
        });

        // ─── 4. ONE insert, through createInTx ──────────────────────────
        // which buys the amend the whole guard set for free:
        // GCASH_REFERENCE_REQUIRED, the verify threshold, the gcashVerified
        // pair, and the duplicate-reference message.
        const replacement = await this.createInTx(tx, {
          userId: dto.userId ?? original.userId,
          membershipId: original.membershipId,
          planId: plan?.id ?? original.planId,
          planCode: plan?.code ?? original.planCode,
          planName: plan?.name ?? original.planName,
          purpose: original.purpose,
          amounts,
          discountType: discountType as unknown as PrismaDiscountType,
          statutoryIdNo: blank(dto.statutoryIdNo, original.statutoryIdNo),
          discountReason: blank(dto.discountReason, original.discountReason),
          termMonths: original.termMonths,
          termStartsOn:
            original.termStartsOn === null ? null : civilDateFromPrisma(original.termStartsOn),
          termEndsOn:
            original.termEndsOn === null ? null : civilDateFromPrisma(original.termEndsOn),
          method: dto.method === undefined ? original.method : (dto.method as PrismaPaymentMethod),
          reference: blank(dto.reference, original.reference),
          gcashVerified: dto.gcashVerified ?? original.gcashVerifiedAt !== null,
          receiptNo: blank(dto.receiptNo, original.receiptNo),
          // Money changed hands when it changed hands. A movable timestamp is
          // a movable business day is a movable till report.
          receivedAt: original.receivedAt,
          businessDate: civilDateFromPrisma(original.businessDate),
          shiftId: original.shiftId,
          recordedById: actor.id,
          idempotencyKey: `amend:${original.id}`,
          idempotencyHash: hashRequestBody(dto),
          notes: blank(dto.notes, original.notes),
          replacesPaymentId: original.id,
        });

        /*
         * ─── 5. THE LINE THAT LOSES REVENUE SILENTLY IF IT IS MISSED. ───
         *
         * `ReportsService.walkInStats` reads `CheckIn.payment.status`. Leave
         * the visit pointing at the voided original and a ₱90 day pass reads
         * as ₱0 forever, with no error anywhere and nothing in any log.
         * `CheckIn_entry_shape` also requires a WALK_IN's paymentId NOT NULL,
         * so the pointer must MOVE, never clear.
         */
        if (original.purpose === 'WALK_IN') {
          await tx.checkIn.updateMany({
            where: { paymentId: original.id },
            data: { paymentId: replacement.id },
          });
        }

        // ─── 6. Same for an approved remote GCash claim ─────────────────
        // GcashSubmission_status_shape requires APPROVED ⇒ paymentId NOT NULL.
        await tx.gcashSubmission.updateMany({
          where: { paymentId: original.id },
          data: { paymentId: replacement.id },
        });

        return { original, replacement, shiftWasClosed: original.shift.closedAt !== null };
      });

      const { original, replacement, shiftWasClosed } = outcome;

      // AFTER the transaction commits, exactly like void().
      //
      // `AuditService.record()` never throws — see its header — and the
      // `.catch()` below is the second belt rather than a substitute for
      // that. The correction is ALREADY COMMITTED and the desk has already
      // told the member; a rejected promise from the trail must not surface
      // as a 500 that makes an operator amend the same payment again (which
      // would then 422 as PAYMENT_ALREADY_AMENDED and look like a bug).
      await this.audit
        .record(
          {
            action: 'PAYMENT_AMENDED',
            actorId: actor.id,
            actorRole: actor.role,
            subjectType: 'Payment',
            // The LIVE row is the subject: that is the one somebody looking
            // the entry up afterwards needs to open.
            subjectId: replacement.id,
            subjectLabel: replacement.receiptNo ?? replacement.reference ?? replacement.id,
            reason: dto.reason,
            // `{ before, after }`, small — never the whole row. An audit log
            // that stores full records is a second copy of the database with
            // none of its constraints.
            details: {
              replacesPaymentId: original.id,
              before: changeShape(original),
              after: changeShape(replacement),
              businessDate: civilDateFromPrisma(original.businessDate),
              shiftId: original.shiftId,
              // §1.1's consequence, in the trail as well as on the screen.
              shiftWasClosed,
            },
          },
          now,
        )
        .catch((caught: unknown) => {
          this.logger.error(
            `Audit entry for amend ${original.id} → ${replacement.id} was not written`,
            caught instanceof Error ? caught.stack : String(caught),
          );
        });

      return toPaymentSummary(replacement);
    } catch (error) {
      // Caught AFTER the whole $transaction call has rejected, so nothing
      // further touches `tx` and the §4.6(d) rule is not violated.
      const mapped = mapPrismaError(error);
      if (mapped) throw mapped;
      throw error;
    }
  }

  /**
   * Hide a payment from the register — a SOFT DELETE, mirroring
   * `User.deletedAt` exactly.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * NO REPORT, NO SHIFT CLOSURE AND NO BIR REGISTER READS `archivedAt`.
   *
   * That is the whole reason the column is safe. `User.deletedAt` is the only
   * other soft delete in this system and exactly one query in the entire
   * reports service filters on it — a soft-deleted member's past payments
   * still count toward revenue. Archiving changes what is SHOWN, never what
   * is COUNTED.
   *
   * ANY status may be archived, INCLUDING RECORDED, and that is deliberate:
   * a hard block would stop it being a soft delete, which is what was asked
   * for. The console's confirm dialog says what archiving does and does not
   * change (`ARCHIVE_LIVE_PAYMENT_WARNING` on the client). Inform, do not
   * block.
   * ═══════════════════════════════════════════════════════════════════════
   */
  async archive(actor: AuthUser, id: string, now: Date): Promise<PaymentSummary> {
    return this.setArchived(actor, id, now, true);
  }

  /** Put an archived payment back on the register. Archiving is reversible. */
  async unarchive(actor: AuthUser, id: string, now: Date): Promise<PaymentSummary> {
    return this.setArchived(actor, id, now, false);
  }

  private async setArchived(
    actor: AuthUser,
    id: string,
    now: Date,
    archived: boolean,
  ): Promise<PaymentSummary> {
    // Pre-read so a missing payment is a 404 rather than "already archived" —
    // the same shape void() uses, for the same reason.
    const existing = await this.prisma.payment.findUnique({ where: { id } });
    if (existing === null) {
      throw new DomainException('PAYMENT_NOT_FOUND', 'Payment not found', HttpStatus.NOT_FOUND);
    }

    // Guarded UPDATE: two operators, one winner. The pair moves together —
    // Payment_archive_shape makes half of it illegal.
    const claimed = await this.prisma.payment.updateMany({
      where: archived ? { id, archivedAt: null } : { id, archivedAt: { not: null } },
      data: archived
        ? { archivedAt: now, archivedById: actor.id }
        : { archivedAt: null, archivedById: null },
    });
    if (claimed.count !== 1) {
      throw archived
        ? new DomainException(
            'PAYMENT_ALREADY_ARCHIVED',
            'This payment is already archived.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          )
        : new DomainException(
            'PAYMENT_NOT_ARCHIVED',
            'This payment is not archived.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
    }

    const row = await this.prisma.payment.findUniqueOrThrow({ where: { id } });

    await this.audit.record(
      {
        action: archived ? 'PAYMENT_ARCHIVED' : 'PAYMENT_UNARCHIVED',
        actorId: actor.id,
        actorRole: actor.role,
        subjectType: 'Payment',
        subjectId: row.id,
        subjectLabel: row.receiptNo ?? row.reference ?? row.id,
        // Said in the trail because it is the one thing somebody reading it
        // later will want to know: hiding a live row changes no figure.
        details: { status: row.status, netCentavos: row.netCentavos, changedAnyFigure: false },
      },
      now,
    );

    return toPaymentSummary(row);
  }

  /**
   * ONE payment, for the register's detail drawer.
   *
   * Scoped through the same `ownedByUser` subject the list uses, so a caller
   * at OWN cannot read a payment by guessing its id.
   */
  async detail(
    id: string,
    scope: ScopedWhere<Prisma.PaymentWhereInput>,
  ): Promise<PaymentDetail> {
    // AND, never spread — `scope` can carry a top-level OR.
    const row = await this.prisma.payment.findFirst({
      where: { AND: [{ id }, scope] },
      include: {
        user: { select: { firstName: true, lastName: true, memberCode: true } },
        recordedBy: { select: { firstName: true, lastName: true } },
        voidedBy: { select: { firstName: true, lastName: true } },
        archivedBy: { select: { firstName: true, lastName: true } },
        gcashVerifiedBy: { select: { firstName: true, lastName: true } },
        replacedBy: { select: { id: true } },
        // Name only, NEVER the phone: guestPhone sits behind member.create on
        // a different route and payment.read is not that key.
        checkIn: { select: { id: true, occurredAt: true, guestName: true } },
        membership: { select: { id: true, planName: true } },
      },
    });
    if (row === null) {
      throw new DomainException(
        'PAYMENT_NOT_FOUND',
        'That payment does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    return toPaymentDetail(row, { vatRegistered: this.gym.vatRegistered });
  }

  /**
   * The service half of Payment_discount_shape, so the CHECK stays a backstop.
   *
   * PUBLIC because it has more than one caller. The front-desk walk-in sale
   * writes a Payment through `createInTx` without going through `record()`,
   * and for a while it therefore skipped this check entirely — a SENIOR sale
   * with no OSCA number reached the database and surfaced as a constraint
   * violation rather than as "enter the ID number".
   */
  assertDiscountShape(
    discountType: DiscountType,
    statutoryIdNo: string | undefined,
    discountReason: string | undefined,
  ): void {
    if (discountType === DiscountType.SENIOR || discountType === DiscountType.PWD) {
      if (statutoryIdNo === undefined || statutoryIdNo.trim() === '') {
        throw new DomainException(
          'STATUTORY_ID_REQUIRED',
          'Enter the OSCA or PWD ID number — BIR keeps that register separately.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      return;
    }

    if (COMP_TYPES.includes(discountType)) {
      if (discountReason === undefined || discountReason.trim().length < 3) {
        throw new DomainException(
          'DISCOUNT_ID_REQUIRED',
          'A discretionary discount needs a reason of at least 3 characters.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }
  }
}
