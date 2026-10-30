import { describe, expect, it } from 'vitest';
import { REPEAT_WEEKS, repeatSummary, repeatWeeksProblem } from './classRepeat';

/** "Repeat weekly" when scheduling a class (owner, 2026-10-30). */

describe('repeatSummary', () => {
  it('says the weekday, the time, how many and the last date', () => {
    // Thu 29 Oct 2026, three weeks on.
    expect(repeatSummary('2026-10-29', '07:00', 4)).toBe(
      'Every Thursday at 7:00 AM, 4 classes, last on 19 Nov',
    );
  });

  it('crosses the end of a month and of a year', () => {
    expect(repeatSummary('2026-11-26', '18:30', 2)).toBe(
      'Every Thursday at 6:30 PM, 2 classes, last on 3 Dec',
    );
    expect(repeatSummary('2026-12-21', '12:00', 12)).toBe(
      'Every Monday at 12:00 PM, 12 classes, last on 8 Mar',
    );
  });

  it('says nothing until the form is filled in with weeks the server would take', () => {
    expect(repeatSummary('', '07:00', 4)).toBeNull();
    expect(repeatSummary('2026-10-29', '', 4)).toBeNull();
    expect(repeatSummary('2026-10-29', '07:00', Number.NaN)).toBeNull();
    expect(repeatSummary('2026-10-29', '07:00', 1)).toBeNull();
    expect(repeatSummary('2026-10-29', '07:00', 13)).toBeNull();
  });
});

describe('repeatWeeksProblem', () => {
  it('takes 2 to 12 whole weeks, and starts at 4', () => {
    expect(REPEAT_WEEKS).toEqual({ min: 2, max: 12, default: 4 });
    for (const weeks of [2, 4, 12]) expect(repeatWeeksProblem(weeks)).toBeNull();
    for (const weeks of [1, 13, 2.5, Number.NaN]) {
      expect(repeatWeeksProblem(weeks)).toBe('Repeat for 2 to 12 weeks.');
    }
  });
});
