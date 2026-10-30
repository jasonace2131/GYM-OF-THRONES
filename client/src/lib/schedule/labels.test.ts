import { describe, expect, it } from 'vitest';
import {
  dayMonth,
  dayNumber,
  longDay,
  longWeekday,
  monthTitle,
  shortDay,
  shortWeekday,
} from './labels';

describe('day labels', () => {
  it('formats civil days without any time zone shift', () => {
    expect(shortWeekday('2026-09-10')).toBe('Thu');
    expect(dayNumber('2026-09-10')).toBe('10');
    expect(shortDay('2026-09-10')).toBe('Thu 10 Sep');
    expect(longDay('2026-09-10')).toBe('Thursday 10 September');
    expect(monthTitle('2026-09-01')).toBe('September 2026');
    expect(longWeekday('2026-09-10')).toBe('Thursday');
    expect(dayMonth('2026-11-26')).toBe('26 Nov');
  });
});
