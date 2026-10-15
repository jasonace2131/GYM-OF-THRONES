import type { Payment, PaymentVoidKind } from '@prisma/client';
import type { DiscountType, PaymentMethod, PaymentPurpose, PaymentStatus } from '@got/shared';
import { civilDateFromPrisma, type CivilDate } from '../common/time/gym-time';

/**
 * The wire shape of a payment.
 *
 * Every money field ends in `Centavos` and is an integer. NO formatted currency
 * string leaves this server, ever: the client composes the peso figure in one
 * place from the integer, so there is one formatting rule instead of one per
 * screen.
 *
 * `businessDate`, `termStartsOn` and `termEndsOn` are @db.Date, so they travel
 * as 'yyyy-mm-dd' civil dates. `receivedAt`, `voidedAt` and `createdAt` are
 * instants and travel as full ISO-8601 strings the client formats with an
 * explicit timeZone (§3.3 rule 3).
 */
export interface PaymentSummary {
  id: string;
  userId: string | null;
  /** Null for a walk-in, or when the query did not join the roster. */
  payerName: string | null;
  membershipId: string | null;
  purpose: PaymentPurpose;
  status: PaymentStatus;
  planCode: string;
  planName: string;
  grossCentavos: number;
  vatBaseCentavos: number;
  discountType: DiscountType;
  discountCentavos: number;
  netCentavos: number;
  vatExempt: boolean;
  statutoryIdNo: string | null;
  discountReason: string | null;
  termMonths: number | null;
  termStartsOn: CivilDate | null;
  termEndsOn: CivilDate | null;
  method: PaymentMethod;
  reference: string | null;
  receiptNo: string | null;
  receiptIssued: boolean;
  receivedAt: string;
  businessDate: CivilDate;
  shiftId: string;
  recordedById: string;
  voidedAt: string | null;
  voidedById: string | null;
  voidReason: string | null;
  // VOID or REFUND, NOT NULL exactly when voidedAt is (Payment_void_kind_shape).
  // Not mirrored into @got/shared: nothing outside the server switches on it,
  // the admin console badges it as an opaque string off the wire.
  voidKind: PaymentVoidKind | null;
  notes: string | null;
}

/**
 * Row → response projection.
 *
 * `idempotencyKey` and `idempotencyHash` are deliberately absent: they are
 * replay-protection mechanism, not information, and shipping the key would
 * invite a client to replay somebody else's.
 *
 * Prisma's enums are string-literal unions and @got/shared's are TS string
 * enums — the same strings, different nominal types — so the boundary takes one
 * cast per enum field. That cast is the whole reason enum-parity.spec.ts exists.
 */
export function toPaymentSummary(
  row: Payment & { user?: { firstName: string; lastName: string } | null },
): PaymentSummary {
  return {
    id: row.id,
    userId: row.userId,
    /*
     * The payments screen rendered a TRUNCATED RAW UUID as the payer, because
     * this presenter sent only `userId` and the list query never joined the
     * roster. Staff looking for "who paid ₱800 on Tuesday" got `a3f1c9d2…`.
     *
     * Optional rather than required: a WALK_IN has no user at all, and the
     * `/me` payment list does not need a name it already knows.
     */
    payerName:
      row.user === undefined || row.user === null
        ? null
        : `${row.user.firstName} ${row.user.lastName}`.trim(),
    membershipId: row.membershipId,
    purpose: row.purpose as unknown as PaymentPurpose,
    status: row.status as unknown as PaymentStatus,
    planCode: row.planCode,
    planName: row.planName,
    grossCentavos: row.grossCentavos,
    vatBaseCentavos: row.vatBaseCentavos,
    discountType: row.discountType as unknown as DiscountType,
    discountCentavos: row.discountCentavos,
    netCentavos: row.netCentavos,
    vatExempt: row.vatExempt,
    statutoryIdNo: row.statutoryIdNo,
    discountReason: row.discountReason,
    termMonths: row.termMonths,
    termStartsOn: row.termStartsOn === null ? null : civilDateFromPrisma(row.termStartsOn),
    termEndsOn: row.termEndsOn === null ? null : civilDateFromPrisma(row.termEndsOn),
    method: row.method as unknown as PaymentMethod,
    reference: row.reference,
    receiptNo: row.receiptNo,
    receiptIssued: row.receiptIssued,
    receivedAt: row.receivedAt.toISOString(),
    businessDate: civilDateFromPrisma(row.businessDate),
    shiftId: row.shiftId,
    recordedById: row.recordedById,
    voidedAt: row.voidedAt === null ? null : row.voidedAt.toISOString(),
    voidedById: row.voidedById,
    voidReason: row.voidReason,
    voidKind: row.voidKind,
    notes: row.notes,
  };
}
