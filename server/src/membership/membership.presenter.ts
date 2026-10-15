import type { Membership, MembershipEvent, MembershipHold, User } from '@prisma/client';
import type { AccessDecision, AllowReason, DenialReason, MembershipStatus } from '@got/shared';
import { civilDateFromPrisma, type CivilDate } from '../common/time/gym-time';
import type { PaymentSummary } from '../payments/payment.presenter';
import {
  accessVerdict,
  type AccessResult,
  type AccessVerdictConfig,
  type MembershipSnapshot,
} from './access-verdict';
import type { BookingSubject } from './booking-eligibility';

type MemberFields = Pick<User, 'firstName' | 'lastName' | 'memberCode' | 'status'>;

/**
 * What the booking ladder's loader reads about one person: their account
 * status, and their membership with every hold that can still move a date.
 * The shape `BOOKING_SUBJECT_SELECT` (membership.service.ts) returns, and the
 * one a caller including the same relations through another model must match.
 */
export type BookingSubjectRow = Pick<User, 'status'> & {
  membership: (Membership & { holds: MembershipHold[] }) | null;
};

export interface HoldView {
  id: string;
  status: string;
  startsOn: CivilDate;
  endsOn: CivilDate;
  daysRequested: number;
  daysApplied: number;
  reason: string;
  feeWaived: boolean;
  releasedAt: string | null;
}

export interface MembershipEventView {
  id: string;
  type: string;
  fromStatus: MembershipStatus | null;
  toStatus: MembershipStatus;
  previousEndsOn: CivilDate | null;
  newEndsOn: CivilDate | null;
  reason: string | null;
  actorId: string | null;
  paymentId: string | null;
  effectiveAt: string;
}

/**
 * The CRM row.
 *
 * `decision` / `allowReason` / `denialReason` are §5.9.3's mitigation for the
 * one thing that genuinely degrades when the nightly job misses a run: a member
 * reading ACTIVE in the CRM while the door correctly denies them. Every list
 * projects the stored status THROUGH accessVerdict, so the CRM and the desk can
 * never disagree in front of a member.
 */
export interface MembershipListItem {
  id: string;
  userId: string;
  memberCode: string | null;
  firstName: string;
  lastName: string;
  planCode: string;
  planName: string;
  status: MembershipStatus;
  startsOn: CivilDate;
  endsOn: CivilDate;
  graceDays: number;
  cancelRequestedOn: CivilDate | null;
  daysRemaining: number | null;
  decision: AccessDecision;
  allowReason: AllowReason | null;
  denialReason: DenialReason | null;
}

export interface MembershipDetail {
  id: string;
  userId: string;
  memberCode: string | null;
  firstName: string;
  lastName: string;
  planId: string;
  planCode: string;
  planName: string;
  planPriceCentavos: number;
  termMonths: number;
  status: MembershipStatus;
  startsOn: CivilDate;
  endsOn: CivilDate;
  graceDays: number;
  billingAnchorDay: number;
  joinedOn: CivilDate;
  cancelRequestedOn: CivilDate | null;
  cancelledOn: CivilDate | null;
  graceAdmissionsThisTerm: number;
  freezesUsedThisTerm: number;
  guestPassesPerTerm: number;
  guestPassesRemaining: number;
  purchasedAt: string;
  verdict: AccessResult;
  hold: HoldView | null;
  events: MembershipEventView[];
  /** Present only when the caller resolved payment.read. */
  payments?: PaymentSummary[];
}

/**
 * Row (+ its running hold) → the snapshot the pure ladder consumes.
 *
 * planName and planPriceCentavos come off the MEMBERSHIP, never off Plan: the
 * snapshot columns are what freeze the commercial terms of the current term, so
 * an admin editing the price list cannot rewrite what anyone agreed to.
 */
export function toMembershipSnapshot(
  row: Membership,
  hold: MembershipHold | null,
): MembershipSnapshot {
  return {
    status: row.status as unknown as MembershipStatus,
    startsOn: civilDateFromPrisma(row.startsOn),
    endsOn: civilDateFromPrisma(row.endsOn),
    graceDays: row.graceDays,
    graceAdmissionsThisTerm: row.graceAdmissionsThisTerm,
    cancelRequestedOn:
      row.cancelRequestedOn === null ? null : civilDateFromPrisma(row.cancelRequestedOn),
    planName: row.planName,
    planPriceCentavos: row.planPriceCentavos,
    hold:
      hold === null
        ? null
        : {
            startsOn: civilDateFromPrisma(hold.startsOn),
            endsOn: civilDateFromPrisma(hold.endsOn),
          },
  };
}

/**
 * A member row → the booking ladder's subject (booking-eligibility.ts).
 *
 * The holds are split by STATUS, never by window. The ACTIVE one is the
 * running hold, handed to toMembershipSnapshot exactly as the door's loaders
 * hand it, so both ladders read one snapshot. Every SCHEDULED one goes to the
 * projection. COMPLETED and CANCELLED holds are dropped even when a caller's
 * include loaded them: an early release marks a hold COMPLETED and leaves its
 * endsOn in place, so its window can cover days that are no longer frozen.
 */
export function toBookingSubject(row: BookingSubjectRow): BookingSubject {
  const membership = row.membership;
  if (membership === null) {
    return { userStatus: row.status, membership: null, scheduledHolds: [], planCode: null };
  }

  // At most one: MembershipHold_active_marker_agrees ties ACTIVE to the
  // nullable-unique activeMembershipId.
  const running = membership.holds.find((hold) => hold.status === 'ACTIVE') ?? null;

  return {
    userStatus: row.status,
    membership: toMembershipSnapshot(membership, running),
    scheduledHolds: membership.holds
      .filter((hold) => hold.status === 'SCHEDULED')
      .map((hold) => ({
        startsOn: civilDateFromPrisma(hold.startsOn),
        endsOn: civilDateFromPrisma(hold.endsOn),
        daysRequested: hold.daysRequested,
      })),
    // The immutable Plan.code, snapshotted at sale and refreshed on every
    // renewal, so the current term's plan is read with no join to Plan.
    planCode: membership.planCode,
  };
}

export function toHoldView(hold: MembershipHold): HoldView {
  return {
    id: hold.id,
    status: hold.status,
    startsOn: civilDateFromPrisma(hold.startsOn),
    endsOn: civilDateFromPrisma(hold.endsOn),
    daysRequested: hold.daysRequested,
    daysApplied: hold.daysApplied,
    reason: hold.reason,
    feeWaived: hold.feeWaived,
    releasedAt: hold.releasedAt === null ? null : hold.releasedAt.toISOString(),
  };
}

export function toMembershipEventView(event: MembershipEvent): MembershipEventView {
  return {
    id: event.id,
    type: event.type,
    fromStatus: event.fromStatus as unknown as MembershipStatus | null,
    toStatus: event.toStatus as unknown as MembershipStatus,
    previousEndsOn:
      event.previousEndsOn === null ? null : civilDateFromPrisma(event.previousEndsOn),
    newEndsOn: event.newEndsOn === null ? null : civilDateFromPrisma(event.newEndsOn),
    reason: event.reason,
    actorId: event.actorId,
    paymentId: event.paymentId,
    effectiveAt: event.effectiveAt.toISOString(),
  };
}

export function toMembershipListItem(
  row: Membership & { user: MemberFields; holds: MembershipHold[] },
  today: CivilDate,
  cfg: AccessVerdictConfig,
): MembershipListItem {
  // dayPassValidToday is false here on purpose: a CRM row answers "what state
  // is this membership in", not "did this person buy a ₱90 pass this morning".
  // The live door verdict (verdictFor) is the only caller that resolves it.
  const verdict = accessVerdict(
    {
      userStatus: row.user.status,
      membership: toMembershipSnapshot(row, row.holds[0] ?? null),
      dayPassValidToday: false,
    },
    today,
    cfg,
  );

  return {
    id: row.id,
    userId: row.userId,
    memberCode: row.user.memberCode,
    firstName: row.user.firstName,
    lastName: row.user.lastName,
    planCode: row.planCode,
    planName: row.planName,
    status: row.status as unknown as MembershipStatus,
    startsOn: civilDateFromPrisma(row.startsOn),
    endsOn: civilDateFromPrisma(row.endsOn),
    graceDays: row.graceDays,
    cancelRequestedOn:
      row.cancelRequestedOn === null ? null : civilDateFromPrisma(row.cancelRequestedOn),
    daysRemaining: verdict.daysRemaining,
    decision: verdict.decision,
    allowReason: verdict.allowReason,
    denialReason: verdict.denialReason,
  };
}

export function toMembershipDetail(
  row: Membership & { user: MemberFields; holds: MembershipHold[]; events: MembershipEvent[] },
  today: CivilDate,
  cfg: AccessVerdictConfig,
  options: { payments: PaymentSummary[] | null; includeEvents: boolean },
): MembershipDetail {
  const hold = row.holds[0] ?? null;
  const verdict = accessVerdict(
    {
      userStatus: row.user.status,
      membership: toMembershipSnapshot(row, hold),
      dayPassValidToday: false,
    },
    today,
    cfg,
  );

  return {
    id: row.id,
    userId: row.userId,
    memberCode: row.user.memberCode,
    firstName: row.user.firstName,
    lastName: row.user.lastName,
    planId: row.planId,
    planCode: row.planCode,
    planName: row.planName,
    planPriceCentavos: row.planPriceCentavos,
    termMonths: row.termMonths,
    status: row.status as unknown as MembershipStatus,
    startsOn: civilDateFromPrisma(row.startsOn),
    endsOn: civilDateFromPrisma(row.endsOn),
    graceDays: row.graceDays,
    billingAnchorDay: row.billingAnchorDay,
    joinedOn: civilDateFromPrisma(row.joinedOn),
    cancelRequestedOn:
      row.cancelRequestedOn === null ? null : civilDateFromPrisma(row.cancelRequestedOn),
    cancelledOn: row.cancelledOn === null ? null : civilDateFromPrisma(row.cancelledOn),
    graceAdmissionsThisTerm: row.graceAdmissionsThisTerm,
    freezesUsedThisTerm: row.freezesUsedThisTerm,
    guestPassesPerTerm: row.guestPassesPerTerm,
    guestPassesRemaining: row.guestPassesRemaining,
    purchasedAt: row.purchasedAt.toISOString(),
    verdict,
    hold: hold === null ? null : toHoldView(hold),
    // The member's own screen gets no staff attribution: every event carries an
    // actorId, and /me has no business knowing which staff member touched the row.
    events: options.includeEvents ? row.events.map(toMembershipEventView) : [],
    ...(options.payments === null ? {} : { payments: options.payments }),
  };
}
