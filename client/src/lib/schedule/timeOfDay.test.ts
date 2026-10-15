import { describe, expect, it } from 'vitest';
import { isTimeFilter, matchesTime, timeOfDay } from './timeOfDay';

describe('timeOfDay — Manila wall clock', () => {
  it.each([
    ['2026-09-15T16:30:00.000Z', 'morning'], // 12:30 AM
    ['2026-09-16T03:59:00.000Z', 'morning'], // 11:59 AM
    ['2026-09-16T04:00:00.000Z', 'afternoon'], // 12:00 PM
    ['2026-09-16T08:59:00.000Z', 'afternoon'], // 4:59 PM
    ['2026-09-16T09:00:00.000Z', 'evening'], // 5:00 PM
  ])('%s is %s', (iso, expected) => {
    expect(timeOfDay(iso)).toBe(expected);
  });

  it('matches "all" for anything', () => {
    expect(matchesTime('2026-09-16T09:00:00.000Z', 'all')).toBe(true);
    expect(matchesTime('2026-09-16T09:00:00.000Z', 'morning')).toBe(false);
  });

  it('recognises only the four filter values', () => {
    expect(isTimeFilter('evening')).toBe(true);
    expect(isTimeFilter('night')).toBe(false);
    expect(isTimeFilter(null)).toBe(false);
  });
});
