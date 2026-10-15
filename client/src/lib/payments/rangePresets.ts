import { GYM_TIMEZONE, addDays, gymToday, type CivilDate } from '@/lib/gymTime';

/**
 * The register's date-range presets.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ DO NOT REACH FOR `new Date().toISOString().slice(0, 10)` HERE.
 *
 * That is UTC. In Manila (UTC+8) it returns YESTERDAY between 00:00 and 08:00
 * local, every day — so "Today" would be silently wrong for the first eight
 * hours of every gym day, with nothing on the screen to say so. That is not
 * hypothetical: `admin/revenue/page.tsx` shipped with exactly that bug in its
 * `daysAgo()` helper, and this module is what both screens use instead.
 *
 * `gymToday` + `addDays` from `lib/gymTime.ts` are the sanctioned helpers and
 * their server mirrors are tested against the same fixture table.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type RangeKey = 'today' | '7d' | '30d' | 'month' | 'all';

export interface DateRange {
  /** `''` means "send no bound at all", not "the beginning of time". */
  from: string;
  to: string;
}

export const RANGE_PRESETS: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'month', label: 'This month' },
  { key: 'all', label: 'All' },
];

/** The first day of the gym-local month `day` falls in. */
function startOfMonth(day: CivilDate): CivilDate {
  return `${day.slice(0, 7)}-01` as CivilDate;
}

export function presetRange(key: RangeKey, now: Date, timeZone: string = GYM_TIMEZONE): DateRange {
  if (key === 'all') return { from: '', to: '' };

  const today = gymToday(now, timeZone);

  switch (key) {
    case 'today':
      return { from: today, to: today };
    // INCLUSIVE of today: "7 days" on a register means this day and the six
    // before it, not a window that quietly omits the day being worked.
    case '7d':
      return { from: addDays(today, -6), to: today };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case 'month':
      return { from: startOfMonth(today), to: today };
  }
}
