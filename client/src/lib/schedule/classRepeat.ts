import { CLASS_REPEAT_WEEKS_MAX } from '@got/shared';
import { hhmmTo12h } from '@/lib/gymTime';
import { shiftDay } from './gymClock';
import { dayMonth, longWeekday } from './labels';

/**
 * "Repeat weekly" when scheduling a class (owner, 2026-10-30): the admin's
 * Schedule a class and the coach's New class, which post to the same route.
 *
 * Pure. The SERVER makes the classes and works out every date, in the gym's
 * zone, all of them or none; this only says what the form is about to ask for.
 *
 * Off by default, four weeks once switched on, two to twelve. One week is not
 * a repeat, so the forms never offer it; the API reads 1 as a single class.
 */
export const REPEAT_WEEKS = { min: 2, max: CLASS_REPEAT_WEEKS_MAX, default: 4 } as const;

/** What is wrong with the number of weeks, or null when the server would take it. */
export function repeatWeeksProblem(weeks: number): string | null {
  return Number.isInteger(weeks) && weeks >= REPEAT_WEEKS.min && weeks <= REPEAT_WEEKS.max
    ? null
    : `Repeat for ${REPEAT_WEEKS.min} to ${REPEAT_WEEKS.max} weeks.`;
}

/**
 * The live line under the switch: "Every Thursday at 7:00 AM, 4 classes, last
 * on 26 Nov". Null until the form holds a date, a start time and a number of
 * weeks the server would take.
 *
 * `date` is a gym day and `start` a gym clock time, exactly what the form
 * holds, so nothing here applies a zone: the line reads the same on a phone
 * set to any country, and it is the same weekday and time the server keeps.
 */
export function repeatSummary(date: string, start: string, weeks: number): string | null {
  if (!/^\d{2}:\d{2}$/.test(start) || repeatWeeksProblem(weeks) !== null) return null;
  let last: string;
  try {
    last = shiftDay(date, 7 * (weeks - 1));
  } catch {
    // Not a yyyy-mm-dd day yet: the date field is still empty.
    return null;
  }
  return `Every ${longWeekday(date)} at ${hhmmTo12h(start)}, ${weeks} classes, last on ${dayMonth(last)}`;
}
