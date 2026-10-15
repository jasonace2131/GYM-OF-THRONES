import { bookingWindowDaysFor, type AllowReason, type MyCheckInSummary } from '@got/shared';
import type { MyBooking } from '@/lib/classes';
import type { AccessResult, MembershipDetail } from '@/lib/portalData';
import { windowSpan } from '@/lib/schedule/bookingWindow';
import { gymClock12, gymParts, shiftDay } from '@/lib/schedule/gymClock';
import { relativeDay } from '@/lib/schedule/cancelCopy';

/**
 * The dashboard's words and numbers, decided here so the components stay thin.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A civil date as "4 Oct". Split and reassembled — a civil date IS the gym's
 * day already, and parsing it into a Date to format it is how the 4th starts
 * displaying as the 3rd for anybody west of Manila. Same shape as the
 * server's `shortDate`, which `denialMemberCopy` expects.
 */
export function dayMonth(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

/** "3-week streak", or nothing at all — "0 week streak" reads as a reproach. */
export function streakLabel(weeks: number): string | null {
  return weeks > 0 ? `${weeks}-week streak` : null;
}

export interface StatTile {
  label: string;
  value: string;
}

/**
 * How far ahead the "Booked" tile and the Upcoming card look: 14 gym days,
 * today included, so today to today + 13.
 *
 * The tile's label is built from this same number, so the label and the fetch
 * cannot drift apart. They had: "next 14 days" over a today-to-today+14 fetch
 * that was really 15 days. It is NOT the member's booking window. A priority
 * plan books 21 days ahead, but the tile still answers "this fortnight" for
 * everyone.
 */
export const UPCOMING_DAYS = 14;

/**
 * The four numbers under the status band. `null` inputs are sections that
 * failed to load; their tiles show a dash rather than a zero, because a zero
 * is a claim ("you have not been in this month") and a dash is not.
 *
 * `booked` is live SEATS only (`UpcomingSummary.booked`). A waitlist place is
 * not a booking yet, so the Upcoming card counts those separately.
 */
export function statTiles(summary: MyCheckInSummary | null, booked: number | null): StatTile[] {
  const show = (value: number | undefined): string =>
    value === undefined ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(1);
  return [
    { label: 'Check-ins this month', value: show(summary?.thisMonth) },
    { label: 'All-time visits', value: show(summary?.allTime) },
    { label: 'Avg. per week', value: show(summary?.avgPerWeek) },
    { label: `Booked · next ${UPCOMING_DAYS} days`, value: show(booked ?? undefined) },
  ];
}

/**
 * The Upcoming card's line about waitlist places, which the "Booked" tile
 * leaves out on purpose. Null when there are none.
 */
export function waitlistLine(waitlisted: number): string | null {
  if (waitlisted === 0) return null;
  return `${waitlisted} waitlist ${waitlisted === 1 ? 'place' : 'places'}, not counted in Booked.`;
}

/**
 * The verdicts that mean the member's plan covers TODAY: the allow reasons of
 * a running term. Grace and a day pass let a member in at the door, but
 * neither books a class (owner, 2026-10-11): a member books only on a day
 * their plan is active.
 */
const RUNNING_TERM: ReadonlySet<AllowReason> = new Set<AllowReason>([
  'MEMBERSHIP_ACTIVE',
  'MEMBERSHIP_EXPIRING_SOON',
  'MEMBERSHIP_EXPIRES_TODAY',
  'MEMBERSHIP_ENDING',
]);

/** True for every member, whatever their plan. */
export const BOOKING_NEEDS_PLAN = 'Booking a class needs a plan that covers the day of the class.';

/**
 * The hint under the Upcoming card's "Nothing booked yet".
 *
 * "Classes for the next two weeks are open for booking" is said only to a
 * member whose plan covers today AND runs to the end of their window, sized by
 * the same shared rule the server books by (`bookingWindowDaysFor`). Everybody
 * else (expired, paused, no plan, grace, a day pass, or a plan that ends
 * inside the window) gets the one sentence that is true for all of them. The
 * timetable says exactly which days, from `GET /me/booking-window`; the
 * dashboard does not pay a fourth request for one sentence.
 */
export function upcomingEmptyHint(
  membership: Pick<MembershipDetail, 'planCode' | 'endsOn'> | null,
  verdict: Pick<AccessResult, 'allowReason'>,
  now: Date,
): string {
  const reason = verdict.allowReason;
  if (membership === null || reason === null || !RUNNING_TERM.has(reason)) {
    return BOOKING_NEEDS_PLAN;
  }
  const windowDays = bookingWindowDaysFor(membership.planCode);
  const lastBookableDay = shiftDay(gymParts(now).date, windowDays - 1);
  // Civil dates compare as strings: yyyy-mm-dd sorts in date order.
  if (membership.endsOn < lastBookableDay) return BOOKING_NEEDS_PLAN;
  return `Classes for the next ${windowSpan(windowDays)} are open for booking.`;
}

/** By the GYM's hour — a member abroad is still greeted for Manila. */
export function greeting(now: Date): string {
  const hour = Math.floor(gymParts(now).minutes / 60);
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** "Next up — Spin tomorrow at 7:00 AM, with Mia Santos." in pieces. */
export function nextUpParts(
  next: MyBooking,
  now: Date,
): { title: string; when: string; coach: string } {
  const day = relativeDay(next.session.businessDate, gymParts(now).date);
  const clock = gymClock12(next.session.startsAt);
  const when =
    day === 'today' || day === 'tomorrow' ? `${day} at ${clock}` : `on ${day} at ${clock}`;
  return { title: next.session.title, when, coach: next.session.coachName };
}

/**
 * Month labels over the heatmap's week columns — one per month, on the first
 * column that starts in it.
 *
 * A label is dropped when the next one lands within two columns: the labels
 * are wider than a column, and a partial month at the left edge ("Mar" one
 * column before "Apr") printed the two on top of each other as "MARPR".
 * Months are read off the civil-date string, never through a Date.
 */
export function heatmapMonthLabels(columnStarts: readonly string[]): (string | null)[] {
  const labels: (string | null)[] = columnStarts.map((day, i) => {
    const month = day.slice(0, 7);
    return i === 0 || month !== columnStarts[i - 1]?.slice(0, 7)
      ? (MONTHS[Number(day.slice(5, 7)) - 1] ?? null)
      : null;
  });

  // The last label may run into the card's padding; only a NEIGHBOUR can collide.
  let next = Number.POSITIVE_INFINITY;
  for (let i = labels.length - 1; i >= 0; i -= 1) {
    if (labels[i] === null) continue;
    if (next - i < MIN_LABEL_GAP) labels[i] = null;
    else next = i;
  }
  return labels;
}

/** Columns a month label needs before the next one may start. */
const MIN_LABEL_GAP = 3;
