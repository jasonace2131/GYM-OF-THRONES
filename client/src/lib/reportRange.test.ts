import { describe, expect, it } from 'vitest';
import { asCivilDate } from './gymTime';
import {
  applyRangeClick,
  rangeFileStem,
  rangeForPreset,
  rangeLabel,
  validateRange,
} from './reportRange';

const day = asCivilDate;
const TODAY = day('2026-09-22');

describe('rangeForPreset', () => {
  /**
   * ─────────────────────────────────────────────────────────────────────────
   * THE HEADLINE REGRESSION: "LAST 7 DAYS" USED TO MEAN EIGHT.
   *
   * `reports/page.tsx` computed `from = shiftDays(7)` and `to = today`, and
   * BOTH bounds are inclusive server-side. 16th through 22nd is seven days;
   * 15th through 22nd is eight. `averagePerDay` divides by the server's
   * inclusive count, so every average on that screen was out by 7/8 — small
   * enough to look like ordinary variance and never be questioned.
   * ─────────────────────────────────────────────────────────────────────────
   */
  it("'7d' spans seven inclusive days, ending today", () => {
    expect(rangeForPreset('7d', TODAY)).toEqual({ from: '2026-09-16', to: '2026-09-22' });
  });

  it("'30d' spans thirty inclusive days, ending today", () => {
    expect(rangeForPreset('30d', TODAY)).toEqual({ from: '2026-08-24', to: '2026-09-22' });
  });

  /**
   * `to` is TODAY, not month-end. A range running into the future divides
   * `averagePerDay` by days that have not happened yet, so on the 3rd of a
   * 31-day month the screen would report a third of the real daily average.
   */
  it("'month' runs from the 1st to TODAY, never to month-end", () => {
    expect(rangeForPreset('month', TODAY)).toEqual({ from: '2026-09-01', to: '2026-09-22' });
  });

  it("'month' on the 1st is a one-day range, not an empty or reversed one", () => {
    expect(rangeForPreset('month', day('2026-03-01'))).toEqual({
      from: '2026-03-01',
      to: '2026-03-01',
    });
  });

  it("'30d' crosses a month and a year boundary by calendar arithmetic", () => {
    expect(rangeForPreset('30d', day('2026-03-01')).from).toBe('2026-01-31');
    expect(rangeForPreset('7d', day('2027-01-03')).from).toBe('2026-12-28');
  });

  /**
   * The two windows Revenue used to own through a private `daysAgo`. They
   * live here now, so every tab of Reports shares one range.
   */
  it("'90d' spans ninety inclusive days, ending today", () => {
    expect(rangeForPreset('90d', TODAY)).toEqual({ from: '2026-06-25', to: '2026-09-22' });
  });

  /**
   * Twelve CALENDAR months — the 1st of the month eleven months back, to
   * today — so a by-month revenue table has twelve rows and no clipped first
   * month. It stays inside the server's 366-day cap.
   */
  it("'12m' runs from the 1st, eleven months back, to today", () => {
    expect(rangeForPreset('12m', TODAY)).toEqual({ from: '2025-10-01', to: '2026-09-22' });
    expect(rangeForPreset('12m', day('2026-01-15'))).toEqual({
      from: '2025-02-01',
      to: '2026-01-15',
    });
    expect(validateRange(rangeForPreset('12m', day('2026-12-31')), day('2026-12-31'))).toBeNull();
  });

  it("'30d' counts 29 February in a leap year", () => {
    // 2028 is a leap year: 30 inclusive days back from 1 March is 1 February,
    // not 2 February, because the 29th exists.
    expect(rangeForPreset('30d', day('2028-03-01')).from).toBe('2028-02-01');
  });
});

describe('applyRangeClick', () => {
  const draft = { from: day('2026-09-10'), to: day('2026-09-20') };

  it('a first click starts a new range and clears the end', () => {
    // `to: null` is the signal the grid and the Apply button both read: a
    // half-built range must not be appliable.
    expect(applyRangeClick(draft, day('2026-09-05'))).toEqual({
      from: '2026-09-05',
      to: null,
    });
  });

  it('a second click after the start closes the range', () => {
    const open = { from: day('2026-09-05'), to: null };
    expect(applyRangeClick(open, day('2026-09-12'))).toEqual({
      from: '2026-09-05',
      to: '2026-09-12',
    });
  });

  /**
   * Clicking BEFORE the open start restarts rather than producing a reversed
   * range. Somebody who clicks the 20th and then realises they meant the 5th
   * is correcting the start, not selecting backwards — and a reversed draft
   * would only surface as a 400 after they pressed Apply.
   */
  it('a second click before the start restarts with that day as the start', () => {
    const open = { from: day('2026-09-12'), to: null };
    expect(applyRangeClick(open, day('2026-09-05'))).toEqual({
      from: '2026-09-05',
      to: null,
    });
  });

  it('the same day clicked twice is a valid one-day range', () => {
    const open = { from: day('2026-09-12'), to: null };
    expect(applyRangeClick(open, day('2026-09-12'))).toEqual({
      from: '2026-09-12',
      to: '2026-09-12',
    });
  });
});

describe('validateRange', () => {
  /**
   * Mirrors `resolveDateWindow`'s rules, plus `to <= today`. The point is to
   * DISABLE Apply rather than round-trip to a 400 the modal would have to
   * translate back into a sentence — and the three server messages are not
   * written for somebody mid-selection.
   */
  it('accepts an ordinary range', () => {
    expect(validateRange({ from: day('2026-09-01'), to: day('2026-09-22') }, TODAY)).toBeNull();
  });

  it('accepts a one-day range', () => {
    expect(validateRange({ from: TODAY, to: TODAY }, TODAY)).toBeNull();
  });

  it('rejects a reversed range', () => {
    expect(validateRange({ from: day('2026-09-22'), to: day('2026-09-01') }, TODAY)).toBeTypeOf(
      'string',
    );
  });

  it('rejects a range that runs past today', () => {
    expect(validateRange({ from: day('2026-09-01'), to: day('2026-09-23') }, TODAY)).toBeTypeOf(
      'string',
    );
  });

  it('accepts a range exactly at the 366-day cap and rejects one day more', () => {
    expect(validateRange({ from: day('2025-09-21'), to: day('2026-09-22') }, TODAY)).toBeNull();
    expect(validateRange({ from: day('2025-09-20'), to: day('2026-09-22') }, TODAY)).toBeTypeOf(
      'string',
    );
  });
});

describe('rangeLabel and rangeFileStem', () => {
  it('labels a range for a human, never as an ISO pair', () => {
    const label = rangeLabel({ from: day('2026-09-16'), to: day('2026-09-22') });

    expect(label).toBe('16 Sep 2026 – 22 Sep 2026');
    // An en dash, not a hyphen: the hyphen is already inside every ISO date
    // and "2026-09-16 - 2026-09-22" is unreadable at a glance.
    expect(label).not.toContain('2026-09-16');
  });

  it('collapses a one-day range to a single date', () => {
    expect(rangeLabel({ from: TODAY, to: TODAY })).toBe('22 Sep 2026');
  });

  it('builds a sortable file stem from the ISO bounds', () => {
    // The FILE name stays ISO: it sorts correctly in a folder, which is the
    // only thing a bookkeeper's download directory does for them.
    expect(rangeFileStem({ from: day('2026-09-16'), to: day('2026-09-22') })).toBe(
      '2026-09-16-to-2026-09-22',
    );
  });
});
