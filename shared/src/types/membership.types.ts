// Enums both runtimes switch on for the commercial model.
//
// Mirrored by Prisma enums in server/prisma/schema/enums.prisma from chunk 1
// onwards. Until then they are listed in PENDING_PRISMA_MIRRORS, and
// server/src/prisma/enum-parity.spec.ts fails if a chunk-1 author adds the
// Prisma side without moving the entry into MIRRORED_ENUM_PAIRS.

/**
 * Exactly four, per spec §3.2. PAST_DUE is deliberately absent: grace is
 * `today <= endsOn + graceDays`, computed from columns already on the row, and
 * a status for it would be a second source of truth a missed nightly run
 * silently falsifies.
 */
export enum MembershipStatus {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  FROZEN = 'FROZEN',
  CANCELLED = 'CANCELLED',
}

/** A term-bearing plan versus a single day's entry. */
export enum PlanKind {
  TERM = 'TERM',
  WALK_IN = 'WALK_IN',
}

/** What a Payment row was collected for. */
export enum PaymentPurpose {
  MEMBERSHIP = 'MEMBERSHIP',
  WALK_IN = 'WALK_IN',
  FREEZE_FEE = 'FREEZE_FEE',
}

/** Cash, or a GCash reference typed by staff. No payment processing exists. */
export enum PaymentMethod {
  CASH = 'CASH',
  GCASH = 'GCASH',
}

/** A void is a status change, never a delete — the drawer must still reconcile. */
export enum PaymentStatus {
  RECORDED = 'RECORDED',
  VOIDED = 'VOIDED',
}

/**
 * SENIOR and PWD are statutory (RA 9994 / RA 10754): a 20% discount plus VAT
 * exemption is mandatory and refusing it is a criminal offence, which is why
 * the desk can ring them without an ADMIN.
 */
export enum DiscountType {
  NONE = 'NONE',
  SENIOR = 'SENIOR',
  PWD = 'PWD',
  PROMO = 'PROMO',
  STAFF = 'STAFF',
  GUEST_PASS = 'GUEST_PASS',
  GOODWILL = 'GOODWILL',
}
