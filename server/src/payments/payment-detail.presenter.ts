import type { Payment } from '@prisma/client';
import { civilDateFromPrisma } from '../common/time/gym-time';
import { toPaymentSummary, type PaymentSummary } from './payment.presenter';
import { paymentDocNo } from './receipt.presenter';

/**
 * ONE payment, for the register's detail drawer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A PRIVACY BOUNDARY, in the same sense `DeskMember` is one.
 *
 * `toPaymentSummary` stays exactly as it is and this composes on top of it,
 * rather than growing the list projection — the register renders twenty rows a
 * page and none of them needs a join to the roster, the shift or the funded
 * visit.
 *
 * DELIBERATELY ABSENT, and they must stay absent:
 *   - `proofPath` — an object key in a PRIVATE bucket. A path in a console
 *     payload is a path in a browser history, a screenshot and a support
 *     ticket. `hasProof` answers the only question the drawer asks.
 *   - `referenceNormalized` — the input to the duplicate-detection index. The
 *     operator already sees `reference` as they typed it.
 *   - `idempotencyKey` / `idempotencyHash` — replay-protection mechanism, not
 *     information. `payment.presenter.ts` says why shipping the key would
 *     invite a client to replay somebody else's.
 *   - `guestPhone` — sits behind `member.create` on
 *     `GET /front-desk/check-ins/:id/guest` and is read only for the
 *     conversion hand-off. `payment.read` is not that key. Do not widen it.
 *   - `planId` — an internal surrogate. `planCode` is the stable identifier
 *     every other surface uses.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is NO VAT breakdown here either. That rendering is legally
 * load-bearing in both directions (RR 7-2024 D.1 and D.2) and lives only in
 * `receipt.presenter.ts`. Duplicating it would create a second thing to get
 * wrong, in a place with no legal review.
 */
export interface PaymentDetail extends PaymentSummary {
  /** The same derivation the printed slip carries — see `paymentDocNo`. */
  docNo: string;
  payerMemberCode: string | null;
  recordedByName: string;
  voidedByName: string | null;
  archivedByName: string | null;
  archivedAt: string | null;
  gcashVerified: boolean;
  gcashVerifiedAt: string | null;
  gcashVerifiedByName: string | null;
  /** A boolean, NEVER the path. */
  hasProof: boolean;
  replacesPaymentId: string | null;
  replacedByPaymentId: string | null;
  /** Name only, NEVER the phone. */
  checkIn: { id: string; occurredAt: string; guestName: string | null } | null;
  membership: { id: string; planName: string } | null;
  /** Drives the amend preview, so the client never guesses the VAT branch. */
  vatRegistered: boolean;
}

type NamedUser = { firstName: string; lastName: string } | null;

/** The row `PaymentsService.detail()` loads. */
export type PaymentDetailRow = Payment & {
  user: { firstName: string; lastName: string; memberCode: string | null } | null;
  recordedBy: { firstName: string; lastName: string };
  voidedBy: NamedUser;
  archivedBy: NamedUser;
  gcashVerifiedBy: NamedUser;
  replacedBy: { id: string } | null;
  checkIn: { id: string; occurredAt: Date; guestName: string | null } | null;
  membership: { id: string; planName: string } | null;
};

function fullName(user: NamedUser): string | null {
  return user === null ? null : `${user.firstName} ${user.lastName}`.trim();
}

export function toPaymentDetail(
  row: PaymentDetailRow,
  seller: { vatRegistered: boolean },
): PaymentDetail {
  return {
    ...toPaymentSummary(row),
    docNo: paymentDocNo(row.id, civilDateFromPrisma(row.businessDate)),
    payerMemberCode: row.user?.memberCode ?? null,
    recordedByName: fullName(row.recordedBy) ?? row.recordedById,
    voidedByName: fullName(row.voidedBy),
    archivedByName: fullName(row.archivedBy),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    // The attestation pair moves together (Payment_gcash_verified_shape), so
    // the timestamp IS the flag — there is no separate boolean column to
    // disagree with it.
    gcashVerified: row.gcashVerifiedAt !== null,
    gcashVerifiedAt: row.gcashVerifiedAt === null ? null : row.gcashVerifiedAt.toISOString(),
    gcashVerifiedByName: fullName(row.gcashVerifiedBy),
    hasProof: row.proofPath !== null,
    replacesPaymentId: row.replacesPaymentId,
    // Derived from the SAME single column, read through the back relation. A
    // stored pair could disagree with itself; this cannot.
    replacedByPaymentId: row.replacedBy?.id ?? null,
    checkIn:
      row.checkIn === null
        ? null
        : {
            id: row.checkIn.id,
            occurredAt: row.checkIn.occurredAt.toISOString(),
            guestName: row.checkIn.guestName,
          },
    membership: row.membership === null ? null : { id: row.membership.id, planName: row.membership.planName },
    vatRegistered: seller.vatRegistered,
  };
}
