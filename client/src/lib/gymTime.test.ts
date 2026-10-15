import { describe, expect, it } from 'vitest';
import {
  addDays,
  asCivilDate,
  civilDateFromPrisma,
  civilDaysBetween,
  formatGymTime,
  gymToday,
  hhmmTo12h,
  isIanaTimeZone,
  toDateColumn,
} from './gymTime';
import { localCivilDate } from './date';

const MANILA = 'Asia/Manila';

describe('gymToday (client mirror)', () => {
  // Byte-identical to server/src/common/time/gym-time.spec.ts. If these two
  // tables ever diverge, so have the two implementations.
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

  it('00:30 and 23:30 Manila on one civil day agree, and are not the UTC day', () => {
    const early = gymToday(new Date('2026-08-17T16:30:00Z'), MANILA); // 00:30 Manila 18th
    const late = gymToday(new Date('2026-08-18T15:30:00Z'), MANILA); // 23:30 Manila 18th
    expect(early).toBe('2026-08-18');
    expect(late).toBe('2026-08-18');
    expect(early).not.toBe(new Date('2026-08-17T16:30:00Z').toISOString().slice(0, 10));
  });
});

describe('civil-date arithmetic (client mirror)', () => {
  it.each([
    ['2026-08-18', 1, '2026-08-19'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2024-02-28', 1, '2024-02-29'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-01-01', -1, '2025-12-31'],
  ] as ReadonlyArray<[string, number, string]>)('%s + %i days is %s', (day, n, expected) => {
    expect(addDays(asCivilDate(day), n)).toBe(expected);
  });

  it('counts whole days between two civil dates', () => {
    expect(civilDaysBetween(asCivilDate('2026-08-18'), asCivilDate('2026-08-21'))).toBe(3);
  });

  it('round-trips a @db.Date value', () => {
    expect(civilDateFromPrisma(toDateColumn(asCivilDate('2026-08-18')))).toBe('2026-08-18');
  });

  it('rejects a full timestamp where a civil date is meant', () => {
    expect(() => asCivilDate('2026-08-18T00:00:00Z')).toThrow(RangeError);
  });

  it('validates time zones by construction', () => {
    expect(isIanaTimeZone('Asia/Calcutta')).toBe(true);
    expect(isIanaTimeZone('Asia/Manilla')).toBe(false);
  });
});

describe('formatGymTime', () => {
  it('renders an instant in gym-local time, not the viewer’s', () => {
    const formatted = formatGymTime(new Date('2026-08-18T15:59:00Z'), MANILA, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    expect(formatted).toBe('23:59');
  });

  it('accepts an ISO string as well as a Date', () => {
    const formatted = formatGymTime('2026-08-18T16:01:00Z', MANILA, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    expect(formatted).toBe('00:01');
  });

  it('defaults to a 12-hour clock a member can read', () => {
    expect(formatGymTime(new Date('2026-08-18T15:59:00Z'), MANILA)).toMatch(/11:59\s?[ap]\.?m\.?/i);
  });
});

/**
 * The gym runs on a 12-hour clock everywhere a person reads one. The STORED
 * value stays `HH:mm` because `closesAt <= opensAt` is a lexicographic
 * correctness check — see the function's own comment.
 */
describe('hhmmTo12h', () => {
  it.each([
    ['05:00', '5:00 AM'],
    ['22:00', '10:00 PM'],
    ['00:00', '12:00 AM'],
    ['00:30', '12:30 AM'],
    ['12:00', '12:00 PM'],
    ['12:45', '12:45 PM'],
    ['09:05', '9:05 AM'],
    ['23:59', '11:59 PM'],
  ])('renders %s as %s', (stored, shown) => {
    expect(hhmmTo12h(stored)).toBe(shown);
  });

  it('returns a malformed value unchanged rather than throwing mid-render', () => {
    expect(hhmmTo12h('25:99')).toBe('25:99');
    expect(hhmmTo12h('')).toBe('');
    expect(hhmmTo12h('closed')).toBe('closed');
  });
});

describe('localCivilDate', () => {
  it('reads the device-local calendar date, not the UTC one', () => {
    // Constructed in local time, so this assertion holds in any TZ the suite
    // happens to run in — which is the point: this helper is device-local by
    // design and is only ever used by the still-mock fixtures.
    expect(localCivilDate(new Date(2026, 7, 18, 23, 30, 0))).toBe('2026-08-18');
    expect(localCivilDate(new Date(2026, 0, 1, 0, 30, 0))).toBe('2026-01-01');
  });
});
