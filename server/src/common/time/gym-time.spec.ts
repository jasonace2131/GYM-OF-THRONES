import {
  addDays,
  anniversary,
  asCivilDate,
  civilDateFromPrisma,
  civilDaysBetween,
  gymToday,
  gymWallClock,
  isIanaTimeZone,
  toDateColumn,
  zonedTimeToInstant,
} from './gym-time';
import type { CivilDate } from './gym-time';

const MANILA = 'Asia/Manila';

describe('gymToday', () => {
  // 15:59Z is 23:59 Manila the same day; 16:01Z is 00:01 Manila the NEXT day.
  // Under toISOString().slice(0, 10) both render as 2026-08-18, which is the
  // bug: the gym opens at 05:00 and every pre-08:00 visit lands on the wrong
  // heatmap square.
  const cases: ReadonlyArray<[string, string, string]> = [
    ['2026-08-18T15:59:00Z', MANILA, '2026-08-18'],
    ['2026-08-18T16:00:00Z', MANILA, '2026-08-19'],
    ['2026-08-18T16:01:00Z', MANILA, '2026-08-19'],
    ['2026-08-18T15:59:00Z', 'UTC', '2026-08-18'],
    ['2026-08-18T16:01:00Z', 'UTC', '2026-08-18'],
    ['2026-08-18T22:30:00Z', MANILA, '2026-08-19'],
    ['2026-01-01T00:30:00Z', MANILA, '2026-01-01'],
    ['2025-12-31T23:30:00Z', MANILA, '2026-01-01'],
    ['2026-08-18T20:00:00Z', 'America/New_York', '2026-08-18'],
  ];

  it.each(cases)('%s in %s is %s', (instant, timeZone, expected) => {
    expect(gymToday(new Date(instant), timeZone)).toBe(expected);
  });

  it('gives different civil dates for 23:59 and 00:01 Manila', () => {
    const before = gymToday(new Date('2026-08-18T15:59:00Z'), MANILA);
    const after = gymToday(new Date('2026-08-18T16:01:00Z'), MANILA);
    expect(before).not.toBe(after);
  });
});

describe('toDateColumn', () => {
  it('produces UTC midnight, which is what a @db.Date column stores', () => {
    expect(toDateColumn(asCivilDate('2026-08-18')).toISOString()).toBe('2026-08-18T00:00:00.000Z');
  });

  it('round-trips through civilDateFromPrisma', () => {
    const day = asCivilDate('2026-02-28');
    expect(civilDateFromPrisma(toDateColumn(day))).toBe('2026-02-28');
  });
});

describe('civilDateFromPrisma', () => {
  it('reads a UTC-midnight Date back as its civil date', () => {
    expect(civilDateFromPrisma(new Date('2026-08-18T00:00:00.000Z'))).toBe('2026-08-18');
  });
});

describe('addDays', () => {
  const cases: ReadonlyArray<[string, number, string]> = [
    ['2026-08-18', 1, '2026-08-19'],
    ['2026-08-18', 0, '2026-08-18'],
    ['2026-08-18', -1, '2026-08-17'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2024-02-28', 1, '2024-02-29'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-01-01', -1, '2025-12-31'],
    ['2026-08-18', 3, '2026-08-21'],
  ];

  it.each(cases)('%s + %i days is %s', (day, n, expected) => {
    expect(addDays(asCivilDate(day), n)).toBe(expected);
  });
});

describe('civilDaysBetween', () => {
  it('counts whole days from a to b', () => {
    expect(civilDaysBetween(asCivilDate('2026-08-18'), asCivilDate('2026-08-21'))).toBe(3);
  });

  it('is zero for the same day', () => {
    expect(civilDaysBetween(asCivilDate('2026-08-18'), asCivilDate('2026-08-18'))).toBe(0);
  });

  it('is negative when b precedes a', () => {
    expect(civilDaysBetween(asCivilDate('2026-08-21'), asCivilDate('2026-08-18'))).toBe(-3);
  });

  it('crosses a year boundary', () => {
    expect(civilDaysBetween(asCivilDate('2025-12-30'), asCivilDate('2026-01-02'))).toBe(3);
  });
});

describe('anniversary', () => {
  // §5.7.2 — the anchor comes from the member's ORIGINAL join date and is
  // never rewritten by clamping. Without it a 31st joiner clamps to Feb 28 and
  // then bills on the 28th forever.
  const clamping: ReadonlyArray<[number, string, number, string]> = [
    [31, '2027-01-31', 1, '2027-02-28'],
    [31, '2027-02-28', 1, '2027-03-31'],
    [31, '2027-03-31', 1, '2027-04-30'],
    [31, '2027-04-30', 1, '2027-05-31'],
    [30, '2027-01-30', 1, '2027-02-28'],
    [15, '2027-01-15', 1, '2027-02-15'],
    [31, '2027-01-31', 3, '2027-04-30'],
    [31, '2027-01-31', 12, '2028-01-31'],
    [1, '2026-12-01', 1, '2027-01-01'],
  ];

  it.each(clamping)('anchor %i from %s + %i months is %s', (anchor, from, months, expected) => {
    expect(anniversary(anchor, asCivilDate(from), months)).toBe(expected);
  });

  it('recovers the anchor after a clamp instead of drifting', () => {
    const clamped = anniversary(31, asCivilDate('2027-01-31'), 1);
    expect(clamped).toBe('2027-02-28');
    expect(anniversary(31, clamped, 1)).toBe('2027-03-31');
  });

  it('walks a full leap cycle and returns the 29th in 2032', () => {
    const a2029 = anniversary(29, asCivilDate('2028-02-29'), 12);
    const a2030 = anniversary(29, a2029, 12);
    const a2031 = anniversary(29, a2030, 12);
    const a2032 = anniversary(29, a2031, 12);
    expect([a2029, a2030, a2031, a2032]).toEqual([
      '2029-02-28',
      '2030-02-28',
      '2031-02-28',
      '2032-02-29',
    ]);
  });

  it('crosses a year boundary', () => {
    expect(anniversary(15, asCivilDate('2026-12-15'), 1)).toBe('2027-01-15');
  });

  it.each([0, 32, 1.5, -1])('rejects an impossible anchor day %p', (anchor) => {
    expect(() => anniversary(anchor, asCivilDate('2026-08-19'), 1)).toThrow(RangeError);
  });
});

describe('asCivilDate', () => {
  it('accepts a yyyy-mm-dd string', () => {
    const day: CivilDate = asCivilDate('2026-08-18');
    expect(day).toBe('2026-08-18');
  });

  it.each(['2026-8-18', '2026-08-18T00:00:00Z', '18-08-2026', '', '2026-02-30', '2026-13-01'])(
    'rejects %p',
    (value) => {
      expect(() => asCivilDate(value)).toThrow(RangeError);
    },
  );
});

describe('isIanaTimeZone', () => {
  it.each(['Asia/Manila', 'Asia/Calcutta', 'UTC', 'America/New_York'])('accepts %s', (zone) => {
    expect(isIanaTimeZone(zone)).toBe(true);
  });

  it.each(['Asia/Manilla', 'Not/AZone', '', 'Manila'])('rejects %p', (zone) => {
    expect(isIanaTimeZone(zone)).toBe(false);
  });
});

describe('gymWallClock', () => {
  // 10:00Z is 18:00 in Manila; 16:00Z is midnight there, which must read 00:00, never 24:00.
  it.each([
    ['2026-09-16T10:00:00Z', '18:00'],
    ['2026-09-15T23:05:00Z', '07:05'],
    ['2026-09-16T16:00:00Z', '00:00'],
  ])('reads %s as %s in Manila', (iso, clock) => {
    expect(gymWallClock(new Date(iso), MANILA)).toBe(clock);
  });

  it('is the form zonedTimeToInstant takes back', () => {
    const start = new Date('2026-10-29T23:00:00Z'); // Fri 30 Oct, 07:00 Manila
    const day = gymToday(start, MANILA);
    expect(zonedTimeToInstant(day, gymWallClock(start, MANILA), MANILA)).toEqual(start);
  });
});
