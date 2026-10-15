import type { CivilDate } from '@got/shared';

/**
 * Client mirror of server/src/common/time/gym-time.ts.
 *
 * Kept deliberately identical function-for-function, with the same fixture
 * table in both specs, so the two runtimes cannot disagree about which day a
 * visit belongs to. CivilDate is re-exported from @got/shared rather than
 * redeclared: a second `unique symbol` brand would be a different type and the
 * server's CivilDate would stop being assignable to the client's.
 *
 * The check-in heatmap does NOT use these to derive buckets — buckets are
 * computed server-side and arrive as { date, visits }. These exist for
 * formatting and for comparing a server-sent civil date against gym today.
 */

export type { CivilDate } from '@got/shared';

/**
 * The gym's zone, and the reason it lives in this leaf module.
 *
 * It used to be declared in `classes.ts`, which imports `api.ts` and therefore
 * `supabase.ts` — a module that throws at import time when the Supabase env
 * vars are absent. Any pure date helper that wanted the zone dragged the whole
 * API client in with it and could not be unit-tested without a browser env.
 * `classes.ts` re-exports this, so every existing importer is unaffected.
 */
export const GYM_TIMEZONE = 'Asia/Manila';

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** The gym's civil calendar date for an instant. en-CA renders ISO-ordered parts. */
export function gymToday(now: Date, timeZone: string): CivilDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now) as CivilDate;
}

/** 'yyyy-mm-dd' → the UTC-midnight Date a @db.Date column round-trips through. */
export function toDateColumn(day: CivilDate): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** The only place `toISOString().slice(0, 10)` is allowed on this side, too. */
export function civilDateFromPrisma(d: Date): CivilDate {
  return d.toISOString().slice(0, 10) as CivilDate;
}

/** Calendar arithmetic via UTC milliseconds, so there is no DST to trip on. */
export function addDays(day: CivilDate, n: number): CivilDate {
  return civilDateFromPrisma(new Date(toDateColumn(day).getTime() + n * MS_PER_DAY));
}

/** Whole days from `a` to `b`. Negative when `b` precedes `a`. */
export function civilDaysBetween(a: CivilDate, b: CivilDate): number {
  return Math.round((toDateColumn(b).getTime() - toDateColumn(a).getTime()) / MS_PER_DAY);
}

/** The only sanctioned way to brand a string as a CivilDate. */
export function asCivilDate(value: string): CivilDate {
  if (!CIVIL_DATE_PATTERN.test(value)) {
    throw new RangeError(`${JSON.stringify(value)} is not a yyyy-mm-dd civil date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${JSON.stringify(value)} is not a real calendar date`);
  }
  return value as CivilDate;
}

/** Validate by construction — supportedValuesOf rejects aliases like Asia/Calcutta. */
export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * A CivilDate rendered for a human: `2026-08-20` → `20 Aug 2026`.
 *
 * NO TIME ZONE IS INVOLVED, and none may be introduced. A CivilDate is already
 * the gym's own calendar day — parsing it into a Date to format it is how a
 * membership that ends on the 20th starts displaying as the 19th for anybody
 * west of Manila. The string is split and reassembled, and that is the whole
 * implementation on purpose.
 *
 * `adminApi.civilDate` is this function, re-exported under its original name so
 * the console's six call sites keep working. One implementation, two names —
 * not two implementations.
 */
export function formatCivilDate(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date} ${MONTHS[(month ?? 1) - 1]} ${year}`;
}

/**
 * Format an INSTANT in gym-local time.
 *
 * Always pass the gym's zone explicitly: a member checking their history from
 * abroad must see the times the gym saw, not the times their phone saw.
 */
export function formatGymTime(
  instant: Date | string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hour12: true },
): string {
  const value = typeof instant === 'string' ? new Date(instant) : instant;
  return new Intl.DateTimeFormat('en-PH', { ...options, timeZone }).format(value);
}

/**
 * A stored `HH:mm` rendered for a human: `05:00` → `5:00 AM`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE STORED VALUE STAYS 24-HOUR, AND THAT IS NOT A DISPLAY DECISION.
 *
 * `OpeningHours.opensAt`, `GYM_OPEN_TIME` and every gate that compares them
 * are `HH:mm` strings because that format sorts and compares lexicographically
 * — `closesAt <= opensAt` is a correctness check, and `"9:00 PM" < "5:00 AM"`
 * is true, which would silently invert it. So the MODEL keeps 24-hour and the
 * VIEW converts here. Nothing that decides whether a door opens ever reads
 * this function's output.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Returns the input unchanged if it is not `HH:mm` — a malformed row already
 * falls back to the environment at the gate, and a screen that throws while
 * rendering a settings table is worse than one showing the raw value.
 */
export function hhmmTo12h(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return value;

  const hour24 = Number(match[1]);
  const minutes = match[2] as string;
  if (hour24 > 23 || Number(minutes) > 59) return value;

  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minutes} ${suffix}`;
}
