/**
 * The register opens this many minutes before a class starts.
 *
 * Early enough that a coach can mark people as they walk in; late enough that
 * nobody can mark a class that is days away — which is how a member ended up
 * holding two seats in one class in production on 2026-09-09.
 */
export const CLASS_REGISTER_OPENS_MINUTES_BEFORE = 30;

/** The instant a class's register opens. Accepts the ISO string or a Date. */
export function registerOpensAt(startsAt: string | Date): Date {
  const start = typeof startsAt === 'string' ? new Date(startsAt) : startsAt;
  return new Date(start.getTime() - CLASS_REGISTER_OPENS_MINUTES_BEFORE * 60_000);
}

/**
 * The waitlist closes this many minutes before a class starts (owner,
 * 2026-10-11).
 *
 * Until then a freed seat goes to the first eligible person waiting, by itself.
 * From then on nobody can JOIN the waitlist, and nobody is promoted: a seat
 * freed after the cutoff goes to whoever books it first — somebody still on the
 * waitlist may take it themselves — or to a walk-in the desk adds. Promoting
 * somebody twenty minutes before a class is a place they cannot reasonably use,
 * and the seat sits empty while they read the notice.
 *
 * One constant for both runtimes, like the register's above: the timetable's
 * "waitlist closed" wording and the server's refusal must not disagree by a
 * minute.
 */
export const CLASS_WAITLIST_CLOSES_MINUTES_BEFORE = 120;

/** The instant a class's waitlist closes. Accepts the ISO string or a Date. */
export function waitlistClosesAt(startsAt: string | Date): Date {
  const start = typeof startsAt === 'string' ? new Date(startsAt) : startsAt;
  return new Date(start.getTime() - CLASS_WAITLIST_CLOSES_MINUTES_BEFORE * 60_000);
}

/**
 * How far ahead a member may book, in gym days, TODAY INCLUDED (owner,
 * 2026-10-11): fourteen days means the last bookable day is today + 13.
 *
 * Counted in gym civil days and compared on a class's `businessDate`, never on
 * instants — a 06:00 Manila class is 22:00 UTC the day before, and an instant
 * comparison would open or shut it a day early. The same rule covers joining a
 * waitlist. A desk user adding somebody by hand is not bound by it.
 */
export const CLASS_BOOKING_WINDOW_DAYS = 14;

/**
 * "Priority class booking" (owner, 2026-10-11): members on a plan in
 * `PRIORITY_BOOKING_PLAN_CODES` book three weeks ahead instead of two — today
 * included, so the last bookable day is today + 20.
 */
export const CLASS_PRIORITY_BOOKING_WINDOW_DAYS = 21;

/**
 * The plans that carry priority booking, by `Plan.code` — the immutable machine
 * code that is snapshotted onto the membership, never the editable name or the
 * display-only perks.
 *
 * QUARTERLY and ANNUAL, by owner decision (2026-10-11); this list is the one
 * place to change if that decision changes. A plan created later in the CRM
 * gets the standard window until it is added here.
 */
export const PRIORITY_BOOKING_PLAN_CODES: readonly string[] = ['QUARTERLY', 'ANNUAL'];

/**
 * Gym days ahead, today included, that a member on `planCode` may book.
 *
 * `null` or `undefined` — no plan, or a plan code not loaded — is the standard
 * window. Whether the member may book AT ALL is a separate question, answered
 * from their membership on the class day; this only says how far ahead.
 */
export function bookingWindowDaysFor(planCode: string | null | undefined): number {
  if (planCode === null || planCode === undefined) return CLASS_BOOKING_WINDOW_DAYS;
  return PRIORITY_BOOKING_PLAN_CODES.includes(planCode)
    ? CLASS_PRIORITY_BOOKING_WINDOW_DAYS
    : CLASS_BOOKING_WINDOW_DAYS;
}

/**
 * "Repeat weekly" (owner, 2026-10-30): the most classes one scheduling request
 * may create, a week apart, the first included — twelve weeks, about three
 * months of a regular slot. The console and the coach's form offer 2 to this;
 * the API takes 1 to this, where 1 (or nothing) is a single class.
 */
export const CLASS_REPEAT_WEEKS_MAX = 12;
