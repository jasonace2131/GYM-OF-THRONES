import { HttpStatus } from '@nestjs/common';
import { MembershipStatus } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';

/**
 * The membership state machine, in one place.
 *
 * PURE: no clock, no Prisma, no config. Every mutating service calls
 * assertTransition(from, to) at the top of its method, so a forbidden
 * transition is refused identically whichever route reached it — and refused
 * LOUDLY. A silent no-op here means the desk believes it froze a lapsed member
 * and the member believes it too, right up until the door refuses them.
 *
 * §5.5.3 lists seven refusals. Three are status pairs and live in this table.
 * The other four are not, and deliberately are not modelled here:
 *   - FROZEN → renewal is 422 MEMBERSHIP_NOT_ACTIVE in MembershipSalesService,
 *     because FROZEN → ACTIVE is legitimate (row 9, early release);
 *   - a second concurrent freeze is refused by MembershipHold's nullable-unique
 *     activeMembershipId, because FROZEN → FROZEN is legitimate (row 16, comp
 *     days while frozen);
 *   - notice on a CANCELLED membership is refused by
 *     MembershipLifecycleService, because CANCELLED → ACTIVE is legitimate
 *     (row 15, reactivation);
 *   - a non-freezable plan and a second freeze in one term are
 *     membership-freeze-rules.ts's, not a status question at all.
 */

const { ACTIVE, EXPIRED, FROZEN, CANCELLED } = MembershipStatus;

export const TRANSITIONS: Readonly<Record<MembershipStatus, ReadonlySet<MembershipStatus>>> =
  Object.freeze({
    // Renewal, notice, withdrawal and comp days all leave it ACTIVE; the
    // nightly job expires or cancels it; a hold freezes it.
    [ACTIVE]: new Set([ACTIVE, EXPIRED, FROZEN, CANCELLED]),
    // Renewal in grace, reactivation past grace, comp days, admin termination.
    // NOT FROZEN: you cannot pause a term you have not paid for.
    [EXPIRED]: new Set([ACTIVE, EXPIRED, CANCELLED]),
    // Hold completes or is released early, comp days, admin termination.
    // NOT EXPIRED: the nightly expiry step excludes FROZEN deliberately.
    [FROZEN]: new Set([ACTIVE, FROZEN, CANCELLED]),
    // Reactivation reuses this same row with a fresh, re-anchored term.
    [CANCELLED]: new Set([ACTIVE]),
  });

/** `from === null` is the creation edge: rows 1 and 2, and it admits only ACTIVE. */
export function isTransitionAllowed(from: MembershipStatus | null, to: MembershipStatus): boolean {
  if (from === null) return to === ACTIVE;
  return TRANSITIONS[from].has(to);
}

/**
 * The one place a forbidden transition is refused. Never silently no-ops.
 */
export function assertTransition(from: MembershipStatus | null, to: MembershipStatus): void {
  if (isTransitionAllowed(from, to)) return;
  const origin = from === null ? 'a new membership (creation)' : from;
  throw new DomainException(
    'MEMBERSHIP_INVALID_TRANSITION',
    `A membership cannot move from ${origin} to ${to}.`,
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/**
 * `membership.status.correct` is the ONLY caller permitted to bypass
 * assertTransition, and it must supply a reason — enforced both by
 * CorrectMembershipDto and by the MembershipEvent_reason_required CHECK.
 * Exported as a constant so the bypass is a documented decision a reader can
 * grep for, rather than an absent call nobody notices.
 */
export const TRANSITION_BYPASS_REASON_REQUIRED = true as const;
