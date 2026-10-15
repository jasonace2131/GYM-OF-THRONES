import { addDays, gymToday, zonedTimeToInstant } from '../common/time/gym-time';

/**
 * The gym-hours window, in one place, because TWO endpoints apply it and they
 * must apply the SAME one.
 *
 * `GET /checkin/station-tokens` refuses to mint outside it (`410 GYM_CLOSED`,
 * so the display renders `CLOSED — opens 5:00 AM`), and `POST /checkin`
 * applies it independently for `method = 'STATION_QR'` — which is what makes a
 * code photographed at 22:29 and relayed at 03:00 worthless twice over. Two
 * copies of this arithmetic would be two windows that drift apart in the one
 * release nobody tests at 04:59.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE GATE NEVER APPLIES TO `MEMBER_CODE` OR `MANUAL`, and this is not a
 * detail. Every path goes through one write service; a gate applied there
 * without a method predicate means an early opening, a public holiday, a
 * `GYM_TIMEZONE` typo or a per-weekday-hours change leaves STAFF STANDING AT
 * THE DESK WITH A MEMBER IN FRONT OF THEM, unable to record anything. A
 * staff-attributed entry is already accountable and does not need a clock to
 * authorise it.
 *
 * The gate lives here and NOT in `accessVerdict()`. That function is a pure
 * function of a `CivilDate` with no time-of-day at all; an hours check inside
 * it would break both its purity and its test contract. §5 is final.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Fifteen minutes either side. Staff arrive before opening and the last member
 * leaves after closing; a gate with no slack turns both into an incident.
 */
export const GYM_HOURS_BUFFER_MINUTES = 15;

export interface GymHours {
  timeZone: string;
  /** `HH:mm`. */
  openTime: string;
  /** `HH:mm`. */
  closeTime: string;
  /**
   * A weekday the gym does not open at all.
   *
   * Optional so every existing caller — and every test built on this shape —
   * keeps working unchanged. `gymHoursWindow` ignores it on purpose: a closed
   * day is a decision made before the window is computed, not a window of
   * zero width, and conflating the two is how "closed Sunday" becomes
   * "denied everybody, reason unclear".
   */
  isClosed?: boolean;
}

export interface GymHoursWindow {
  opensAt: Date;
  closesAt: Date;
}

/** `[open − 15m, close + 15m]` for the gym's civil TODAY, as real instants. */
export function gymHoursWindow(now: Date, hours: GymHours): GymHoursWindow {
  const today = gymToday(now, hours.timeZone);
  const bufferMs = GYM_HOURS_BUFFER_MINUTES * 60_000;

  return {
    opensAt: new Date(
      zonedTimeToInstant(today, hours.openTime, hours.timeZone).getTime() - bufferMs,
    ),
    closesAt: new Date(
      zonedTimeToInstant(today, hours.closeTime, hours.timeZone).getTime() + bufferMs,
    ),
  };
}

export function isWithinGymHours(now: Date, hours: GymHours): boolean {
  const window = gymHoursWindow(now, hours);
  return now >= window.opensAt && now <= window.closesAt;
}

/**
 * The next real opening instant — today's if the gym has not opened yet,
 * tomorrow's once it has closed. Rendered by the display as `opens 5:00 AM`
 * and by the phone as the one useful sentence a closed gym can offer.
 *
 * Deliberately the UNBUFFERED opening time: telling a member the doors open at
 * 04:45 because the gate opens then would be a lie about the building.
 */
export function nextOpensAt(now: Date, hours: GymHours): Date {
  const window = gymHoursWindow(now, hours);
  const today = gymToday(now, hours.timeZone);
  return now < window.opensAt
    ? zonedTimeToInstant(today, hours.openTime, hours.timeZone)
    : zonedTimeToInstant(addDays(today, 1), hours.openTime, hours.timeZone);
}
