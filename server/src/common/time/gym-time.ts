import type { CivilDate } from '@got/shared';

/**
 * Gym-local civil dates. The structural fix for portalData.ts's `iso()`.
 *
 * Two kinds of temporal value, two column types, two rules:
 *   - a business day is @db.Date, is a CivilDate here, and is compared as a
 *     plain string ('a < b' works on yyyy-mm-dd — there is no helper for it);
 *   - an instant is @db.Timestamptz(3), stays a Date, and is formatted with an
 *     explicit timeZone.
 *
 * `gymToday` takes `now` as a parameter rather than reading the clock, so every
 * date rule is unit-testable without a fixture.
 *
 * Documented constraint: civil business date equals calendar date, which holds
 * while the gym is closed at local midnight. If it ever goes 24/7 the single
 * change is a cutover hour inside gymToday(). Not built now.
 */

// Re-exported so `import { CivilDate } from './gym-time'` resolves, while the
// brand itself stays defined exactly once in @got/shared. Two `unique symbol`
// brands would be two incompatible types.
export type { CivilDate } from '@got/shared';

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * The gym's civil calendar date for an instant.
 *
 * en-CA renders ISO-ordered parts, so there is no dependency, no hand-rolled
 * offset arithmetic, and DST / tzdata changes are the platform's problem.
 */
export function gymToday(now: Date, timeZone: string): CivilDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now) as CivilDate;
}

/** 'yyyy-mm-dd' → the value a Prisma `@db.Date` column expects. */
export function toDateColumn(day: CivilDate): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * A `@db.Date` column comes back from Prisma as a JS Date at UTC MIDNIGHT.
 * For those values `toISOString().slice(0, 10)` is CORRECT — the identical call
 * that is a bug on a real timestamp. This is the only place either form is
 * allowed anywhere in this repository.
 */
export function civilDateFromPrisma(d: Date): CivilDate {
  return d.toISOString().slice(0, 10) as CivilDate;
}

/** Calendar arithmetic via Date.UTC, so there is no DST to trip on. */
export function addDays(day: CivilDate, n: number): CivilDate {
  const shifted = new Date(toDateColumn(day).getTime() + n * MS_PER_DAY);
  return civilDateFromPrisma(shifted);
}

/** Whole days from `a` to `b`. Negative when `b` precedes `a`. */
export function civilDaysBetween(a: CivilDate, b: CivilDate): number {
  return Math.round((toDateColumn(b).getTime() - toDateColumn(a).getTime()) / MS_PER_DAY);
}

/**
 * The same day-of-month `months` out, clamped to that month's last day.
 *
 * `anchorDay` is the member's ORIGINAL join day-of-month and is passed in
 * rather than read off `from`, which is the whole point: each term computes
 * from the anchor, not from the previous clamped date, so a 31st joiner who
 * clamps to Feb 28 recovers the 31st in March instead of billing on the 28th
 * forever (§5.7.2).
 *
 * Date.UTC normalises a month index past 11 into the following year, so no
 * year arithmetic is written here. Day 0 of month+1 is the last day of month.
 */
export function anniversary(anchorDay: number, from: CivilDate, months: number): CivilDate {
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new RangeError(`${JSON.stringify(anchorDay)} is not a day-of-month anchor (1..31)`);
  }
  if (!Number.isInteger(months)) {
    throw new RangeError(`${JSON.stringify(months)} is not a whole number of months`);
  }
  const base = toDateColumn(from);
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth() + months;
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return civilDateFromPrisma(new Date(Date.UTC(year, month, Math.min(anchorDay, lastDayOfMonth))));
}

/**
 * The only sanctioned way to brand a string as a CivilDate.
 *
 * Rejects anything with a time in it: a timestamp arriving where a civil date
 * is meant is exactly how the UTC+8 bug gets reintroduced.
 */
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

const HH_MM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The offset (minutes, east-positive) `timeZone` was at `instant`.
 *
 * Computed by re-reading `instant` back through the zone rather than looked
 * up from a table, so it costs nothing to keep correct across a DST
 * transition the gym's own zone (Asia/Manila, fixed UTC+8) never has but a
 * future second branch's zone might.
 */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * The instant a `HH:mm` wall-clock time on a given gym-local civil date
 * corresponds to, in UTC.
 *
 * Used only where a time-of-day gate needs a real instant to compare `now`
 * against — the station-token mint window (§6.2.4) — never for a civil-date
 * comparison, which stays a plain string compare per this file's own rule.
 *
 * One offset-correction pass is exact for `Asia/Manila` (no DST) and correct
 * to within the rare cross-zone DST-transition minute for any zone this
 * project might target later; that residual is a UX rounding, not a security
 * boundary, so a second correction pass is not worth the complexity here.
 */
export function zonedTimeToInstant(day: CivilDate, hhmm: string, timeZone: string): Date {
  const match = HH_MM_PATTERN.exec(hhmm);
  if (!match) {
    throw new RangeError(`${JSON.stringify(hhmm)} is not an HH:mm time of day`);
  }
  const [year, month, date] = day.split('-').map(Number);
  const hour = Number(match[1]);
  const minute = Number(match[2]);

  const naiveUtc = Date.UTC(year, month - 1, date, hour, minute, 0);
  const offset = offsetMinutesAt(new Date(naiveUtc), timeZone);
  return new Date(naiveUtc - offset * 60_000);
}

/**
 * An INSTANT's gym-local wall-clock time as 24-hour `HH:mm` ('18:00') — the
 * form `zonedTimeToInstant` takes back, so a time of day can be carried to
 * another gym date without adding milliseconds to an instant. `gymClockTime`
 * below is the one people read.
 *
 * hourCycle h23, not hour12:false: some ICU builds render midnight as "24".
 */
export function gymWallClock(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

/**
 * Validate a time zone by CONSTRUCTION, never by regex and never by
 * Intl.supportedValuesOf('timeZone').
 *
 * supportedValuesOf returns only canonical names and rejects valid IANA aliases
 * such as Asia/Calcutta, which would crash startup on a legitimate value. A
 * regex would pass 'Asia/Manilla' and then format as UTC for the life of the
 * deployment.
 */
export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    // Intl throws RangeError only on an unknown zone.
    return false;
  }
}

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * '2026-08-16' -> '16 Aug'.
 *
 * Pure string work on a CivilDate: no Intl, no Date, no locale drift, and
 * structurally incapable of the off-by-one a timezone-naive formatter
 * produces for every gym-local date before 08:00 Manila.
 */
export function shortDate(day: CivilDate): string {
  return `${Number(day.slice(8, 10))} ${SHORT_MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

/**
 * An INSTANT rendered as a gym-local wall-clock time: '6:14 PM'.
 *
 * Intl with an explicit timeZone, per this file's second rule. Never used on a
 * `@db.Date` value — that is `shortDate`'s job, and mixing the two is exactly
 * the bug the two-rules split exists to make impossible.
 */
export function gymClockTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(instant);
}
