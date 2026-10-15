import { describe, expect, it } from 'vitest';
import { presetRange, RANGE_PRESETS, type RangeKey } from './rangePresets';

/**
 * ⚠ THE REGRESSION GUARD FOR THE `daysAgo()` UTC BUG.
 *
 * `admin/revenue/page.tsx` computed its range with
 * `new Date().toISOString().slice(0, 10)` — UTC. In Manila (UTC+8) that
 * returns YESTERDAY between 00:00 and 08:00 local, every single day, so
 * "Today" on the revenue screen was silently wrong for the first eight hours
 * of every gym day and nothing on the screen said so.
 *
 * 01:00 Manila is 17:00 UTC the PREVIOUS day, which is why that instant is
 * the fixture here.
 */
const ONE_AM_MANILA = new Date('2026-09-22T01:00:00+08:00');

describe('presetRange', () => {
  it('resolves Today to the MANILA civil date at 01:00 Manila, not the UTC one', () => {
    expect(ONE_AM_MANILA.toISOString().slice(0, 10)).toBe('2026-09-21'); // the bug
    expect(presetRange('today', ONE_AM_MANILA)).toEqual({
      from: '2026-09-22',
      to: '2026-09-22',
    });
  });

  it('counts 7 days INCLUSIVE of today', () => {
    expect(presetRange('7d', ONE_AM_MANILA)).toEqual({ from: '2026-09-16', to: '2026-09-22' });
  });

  it('counts 30 days inclusive of today', () => {
    expect(presetRange('30d', ONE_AM_MANILA)).toEqual({ from: '2026-08-24', to: '2026-09-22' });
  });

  it('runs This month from the gym-local first of the month to gym-local today', () => {
    expect(presetRange('month', ONE_AM_MANILA)).toEqual({ from: '2026-09-01', to: '2026-09-22' });
  });

  it('sends no bounds at all for All — an unset filter, not a wide one', () => {
    expect(presetRange('all', ONE_AM_MANILA)).toEqual({ from: '', to: '' });
  });

  it('is correct at midday too, where the UTC bug would have hidden', () => {
    const noon = new Date('2026-09-22T12:00:00+08:00');
    expect(presetRange('today', noon)).toEqual({ from: '2026-09-22', to: '2026-09-22' });
  });

  it('exposes every preset key exactly once, in the order the toolbar renders', () => {
    expect(RANGE_PRESETS.map((preset) => preset.key)).toEqual([
      'today',
      '7d',
      '30d',
      'month',
      'all',
    ] satisfies RangeKey[]);
  });
});
