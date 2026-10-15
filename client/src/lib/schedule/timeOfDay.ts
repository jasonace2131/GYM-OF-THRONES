import { gymParts } from './gymClock';

export type TimeOfDay = 'morning' | 'afternoon' | 'evening';
export type TimeFilter = 'all' | TimeOfDay;

const FILTERS: readonly TimeFilter[] = ['all', 'morning', 'afternoon', 'evening'];

/** Morning < 12:00, Afternoon 12:00-16:59, Evening >= 17:00 — Manila wall clock. */
export function timeOfDay(startsAt: string): TimeOfDay {
  const { minutes } = gymParts(startsAt);
  if (minutes < 12 * 60) return 'morning';
  if (minutes < 17 * 60) return 'afternoon';
  return 'evening';
}

export function matchesTime(startsAt: string, filter: TimeFilter): boolean {
  return filter === 'all' || timeOfDay(startsAt) === filter;
}

export function isTimeFilter(value: unknown): value is TimeFilter {
  return typeof value === 'string' && (FILTERS as readonly string[]).includes(value);
}
