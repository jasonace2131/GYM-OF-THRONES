import type { Role } from '@prisma/client';
import type { MemberAccess } from '@got/shared';
import type { CivilDate } from '../common/time/gym-time';
import { bookingEligibility } from './booking-eligibility';
import type { BookingSubject } from './booking-eligibility';

/**
 * Member-only features — Workouts, Ask the Gym, My Progress, My Coach — need
 * an ACTIVE membership (owner, 2026-10-17, re-confirmed 2026-10-20).
 *
 * "Active" is the class-booking rule (owner, 2026-10-11), asked about TODAY:
 * grace days, day passes, a freeze, an expired or cancelled plan and no plan
 * at all do not count. It is deliberately `bookingEligibility` itself, not a
 * second definition — the day the booking rule changes, this changes with it.
 *
 * PURE, like booking-eligibility.ts: `today` is an argument and the loading
 * is MembershipService.hasActiveMembership's.
 */
export function hasActiveMembership(subject: BookingSubject | null, today: CivilDate): boolean {
  return subject !== null && bookingEligibility(subject, today).eligible;
}

/**
 * Whose calls the gate applies to: a member (CLIENT) acting on their own
 * account. Staff — the desk, coaches, admins, DEV — use some of the same
 * routes for their work (a coach sends chat messages) and are not members
 * here (owner, 2026-09-25), so their own membership is never asked about.
 */
export function isMembershipGated(role: Role): boolean {
  return role === 'CLIENT';
}

/**
 * `GET /me`'s `memberAccess` (shared `MemberAccess`): FULL when the gate lets
 * the caller through, LOCKED for a member who never had a membership, and
 * READ_ONLY for one whose membership exists but is not active today.
 */
export function memberAccess(
  role: Role,
  subject: BookingSubject | null,
  today: CivilDate,
): MemberAccess {
  if (!isMembershipGated(role)) return 'FULL';
  if (hasActiveMembership(subject, today)) return 'FULL';
  return subject === null || subject.membership === null ? 'LOCKED' : 'READ_ONLY';
}

/** The 403's member copy (owner wording). */
export const MEMBERSHIP_REQUIRED_MESSAGE = 'This needs an active membership.';
