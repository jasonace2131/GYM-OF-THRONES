import { describe, expect, it } from 'vitest';
import { monthGrid } from './monthGrid';

/**
 * ─────────────────────────────────────────────────────────────────────────
 * EVERY ASSERTION HERE IS ON A STRING, ON PURPOSE.
 *
 * `new Date('2026-08-24')` is UTC midnight, which in Manila is 8 AM on the
 * 24th and renders as the 23rd for anybody west of the gym. The whole class
 * of off-by-one-day calendar bugs lives in that constructor. Asserting the
 * emitted STRINGS is what proves no civil date round-tripped through a local
 * Date on the way out — a Date-valued assertion would agree with a broken
 * implementation in the test runner's own zone and disagree in Manila.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('monthGrid', () => {
  it('pads a month that starts on a Sunday with six Monday-first lead cells', () => {
    // 2026-11-01 is a Sunday. Monday-first means it is the SEVENTH cell, so
    // six days of October lead it. A Sunday-first grid would have zero.
    const cells = monthGrid('2026-11');

    const lead = cells.filter((cell) => !cell.inMonth).slice(0, 6);
    expect(cells.slice(0, 6)).toEqual(lead);
    expect(cells[0]?.day).toBe('2026-10-26');
    expect(cells[5]?.day).toBe('2026-10-31');
    expect(cells[6]).toEqual({ day: '2026-11-01', inMonth: true });
  });

  it('always emits whole weeks', () => {
    for (const month of ['2026-01', '2026-02', '2026-09', '2026-11', '2028-02', '2100-02']) {
      expect(monthGrid(month).length % 7).toBe(0);
    }
  });

  it('brackets a common February exactly', () => {
    // 2026-02-01 is a Sunday: six lead cells from January, 28 own days, and
    // one trail cell — which must be 1 March.
    const cells = monthGrid('2026-02');

    expect(cells[0]?.day).toBe('2026-01-26');
    expect(cells).toHaveLength(35);
    expect(cells[34]).toEqual({ day: '2026-03-01', inMonth: false });
  });

  it('brackets a leap February exactly', () => {
    // 2028-02-01 is a Tuesday and 2028 is a leap year, so the 29th exists.
    const cells = monthGrid('2028-02');

    expect(cells[0]?.day).toBe('2028-01-31');
    expect(cells[cells.length - 1]?.day).toBe('2028-03-05');
    expect(cells.some((cell) => cell.day === '2028-02-29' && cell.inMonth)).toBe(true);
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * THE TRAIL BUG THIS EXTRACTION EXPOSED, PINNED.
   *
   * The original used `daysInMonth + (cells.length % 7)` as the trail day,
   * which only lands correctly when six trail cells are needed. September
   * 2026's renewals grid ended "3 4 5 6 October" instead of "1 2 3 4", so a
   * renewal due on 1 October appeared in no trailing row while one due on the
   * 6th appeared in September's grid AND October's. The dates are greyed, but
   * a renewals calendar is a call sheet.
   * ─────────────────────────────────────────────────────────────────────────
   */
  it('starts the trail on the FIRST of the next month, never partway in', () => {
    for (const [month, firstTrail] of [
      ['2026-02', '2026-03-01'],
      ['2026-09', '2026-10-01'],
      ['2028-02', '2028-03-01'],
      ['2026-11', '2026-12-01'],
    ] as const) {
      const cells = monthGrid(month);
      const trail = cells.slice(cells.findIndex((cell) => cell.inMonth)).filter((c) => !c.inMonth);

      expect(trail[0]?.day).toBe(firstTrail);
      // …and runs consecutively from there.
      trail.forEach((cell, index) => {
        const expected = new Date(`${firstTrail}T00:00:00.000Z`);
        expected.setUTCDate(expected.getUTCDate() + index);
        expect(cell.day).toBe(expected.toISOString().slice(0, 10));
      });
    }
  });

  it('marks every lead and trail cell out of month, and nothing else', () => {
    const cells = monthGrid('2028-02');

    for (const cell of cells) {
      expect(cell.inMonth).toBe(cell.day.startsWith('2028-02'));
    }
  });

  it('emits each day of the month exactly once, in order', () => {
    const inMonth = monthGrid('2026-09')
      .filter((cell) => cell.inMonth)
      .map((cell) => cell.day);

    expect(inMonth).toHaveLength(30);
    expect(inMonth[0]).toBe('2026-09-01');
    expect(inMonth[29]).toBe('2026-09-30');
    expect(new Set(inMonth).size).toBe(30);
  });
});
