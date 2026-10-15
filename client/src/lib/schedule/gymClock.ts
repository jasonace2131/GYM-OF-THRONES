// Imported from gymTime, not classes: classes.ts pulls in the Supabase client,
// which would make these pure helpers unloadable without browser env vars.
import { GYM_TIMEZONE, addDays, asCivilDate, hhmmTo12h } from '@/lib/gymTime';

/**
 * The gym's wall clock for an instant.
 *
 * Every schedule screen asks two questions of a class: which gym day is it on,
 * and how far into that day does it start. Both are answered here, in the
 * gym's zone, so a phone set to Singapore or London renders the same grid.
 */
export interface GymParts {
  /** yyyy-mm-dd in Asia/Manila. */
  date: string;
  /** Minutes since Manila midnight, 0-1439. */
  minutes: number;
}

// hourCycle h23, not hour12:false — some ICU builds render midnight as "24".
const PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: GYM_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function gymParts(instant: string | Date): GymParts {
  const value = typeof instant === 'string' ? new Date(instant) : instant;
  const parts: Record<string, string> = {};
  for (const part of PARTS.formatToParts(value)) parts[part.type] = part.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** `5:30 PM` in Manila. Built from minutes so tests never meet ICU spacing. */
export function gymClock12(instant: string | Date): string {
  const { minutes } = gymParts(instant);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return hhmmTo12h(`${hh}:${mm}`);
}

export function shiftDay(day: string, n: number): string {
  return addDays(asCivilDate(day), n);
}

/** Monday of the Monday-start week containing `day`. */
export function mondayOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
  return shiftDay(day, weekday === 0 ? -6 : 1 - weekday);
}

export function dayRange(first: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftDay(first, i));
}
