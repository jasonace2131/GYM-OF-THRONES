import type { CivilDate } from '../common/time/gym-time';

/**
 * The coach's own dashboard, on the wire.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS LIVES UNDER `/me` AND NOT UNDER `/admin`.
 *
 * A COACH is not staff as this system defines staff. `isStaff()` in the client
 * requires `member.read` at a scope that reaches other people, and COACH holds
 * `member.read` at OWN — deliberately, and the comment in `safeNext.ts` records
 * the bug that came from getting this wrong: coaches were routed into the CRM
 * shell and shown a dashboard firing `payment.read` calls that could never
 * succeed for them.
 *
 * So the coach's dashboard is a section of the portal they already land in, and
 * its data comes from `/me/coaching/*` — keyless in the same sense as the rest
 * of `/me`: the coach is `request.user.id`, never a parameter. There is no
 * `coachId` to pass and therefore no `coachId` to tamper with.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Instants travel as ISO strings and are formatted client-side with an explicit
 * `timeZone`; civil dates travel as `YYYY-MM-DD` strings. The same rule the
 * class presenter follows, and for the same reason.
 */

export interface CoachSummary {
  /** ACTIVE assignments where I am the coach. */
  assignedMembers: number;
  /** Non-cancelled sessions I run in the gym-local week that contains today. */
  sessionsThisWeek: number;
  sessionsToday: number;
  /**
   * Today's register, across every session I run today.
   *
   * `bookedToday` counts every SEAT — booked, and already marked — and never a
   * waitlist place, which has no seat to mark. `markedToday` counts the ones
   * that have been marked. The pair is what makes "12 of 18 marked" a sentence
   * rather than two numbers, and one that reaches "18 of 18".
   */
  bookedToday: number;
  markedToday: number;
  /** The window `sessionsThisWeek` counted, so no client recomputes it. */
  weekFrom: CivilDate;
  weekTo: CivilDate;
}

export interface CoachSession {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  businessDate: CivilDate;
  capacity: number;
  bookedCount: number;
  seatsLeft: number;
  cancelledAt: string | null;
  cancelReason: string | null;
  /**
   * Register progress for this one session. `marked` is `attended + noShow`,
   * carried explicitly rather than left for the client to add up — a screen
   * that derives the same number two ways eventually disagrees with itself.
   */
  attended: number;
  noShow: number;
  marked: number;
}

export interface CoachMemberRow {
  userId: string;
  firstName: string;
  lastName: string;
  memberCode: string | null;
  avatarUrl: string | null;
  /** When this assignment started. */
  since: string;
  /** Their most recent admitted visit, or null if they have never been in. */
  lastVisitAt: string | null;
  /** Admitted visits in the last 30 gym-local days. */
  visits30d: number;
  /** Whether they are inside the gym right now — an open, unvoided visit. */
  inGymNow: boolean;
  /**
   * Class attendance, all-time, across every class they booked — not only
   * mine. A coach asking "does this person turn up" wants the answer about
   * the gym, and restricting the denominator to my own sessions would report
   * "no data" for every member of a coach who runs no classes.
   *
   * Only marked bookings count: a booking still sitting at BOOKED has not
   * happened yet, and counting it as a miss would punish a member for having
   * a class on Thursday.
   */
  classesAttended: number;
  classesMarked: number;
  /**
   * `classesAttended / classesMarked`, 0-100, rounded — or NULL when nothing
   * has been marked yet.
   *
   * NULL rather than 0. A member who has never had a class to attend has not
   * attended 0% of them; printing "0%" against their name is a judgement the
   * data does not support, and it is the first number a member would dispute.
   */
  attendanceRate: number | null;
}
