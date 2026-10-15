import { describe, expect, it } from 'vitest';
import { dayRange, gymClock12, gymParts, mondayOf, shiftDay } from './gymClock';

describe('gymParts', () => {
  it('reads the Manila day and minutes, not UTC', () => {
    // 16:00Z is midnight in Manila — the next calendar day.
    expect(gymParts('2026-09-09T16:00:00.000Z')).toEqual({ date: '2026-09-10', minutes: 0 });
    expect(gymParts('2026-09-16T10:00:00.000Z')).toEqual({ date: '2026-09-16', minutes: 18 * 60 });
  });

  it('accepts a Date', () => {
    expect(gymParts(new Date('2026-09-09T12:45:00.000Z'))).toEqual({
      date: '2026-09-09',
      minutes: 20 * 60 + 45,
    });
  });
});

describe('gymClock12', () => {
  it('formats Manila wall clock as 12-hour with a plain space', () => {
    expect(gymClock12('2026-09-16T09:30:00.000Z')).toBe('5:30 PM');
    expect(gymClock12('2026-09-15T16:30:00.000Z')).toBe('12:30 AM');
  });
});

describe('civil day arithmetic', () => {
  it('shifts across a month end', () => {
    expect(shiftDay('2026-09-30', 1)).toBe('2026-10-01');
    expect(shiftDay('2026-09-01', -1)).toBe('2026-08-31');
  });

  it('opens a week on Monday, with Sunday at its end', () => {
    expect(mondayOf('2026-09-13')).toBe('2026-09-07'); // Sunday
    expect(mondayOf('2026-09-07')).toBe('2026-09-07'); // Monday
    expect(mondayOf('2026-09-10')).toBe('2026-09-07'); // Thursday
  });

  it('lists consecutive days', () => {
    expect(dayRange('2026-09-29', 3)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
  });
});
