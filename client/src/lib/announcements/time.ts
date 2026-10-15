import { civilDaysBetween, type CivilDate } from '@/lib/gymTime';
import { gymClock12, gymParts } from '@/lib/schedule/gymClock';
import { shortDay, shortWeekday } from '@/lib/schedule/labels';

/**
 * When a notice went up, in words — the bell's rows and the dashboard's notices.
 *
 * DAYS ARE THE GYM'S DAYS. "Yesterday" and the weekday are read in Manila, not
 * on the phone's clock and not in UTC: 01:00 on the 24th in Manila is 17:00 on
 * the 23rd in UTC, and a UTC calendar would call a notice posted before
 * breakfast "Yesterday" all morning.
 *
 * The ladder: "Just now" (< 1 min, and any future stamp — a slow phone clock
 * must never produce "in 2 min"), "5 min ago" (< 1 hr), "3 hr ago" (same gym
 * day), "Yesterday", "Mon" (within the week), "16 Sep", "16 Sep 2025".
 */
export function relativeTime(iso: string, now: Date): string {
  const at = new Date(iso);
  const elapsed = now.getTime() - at.getTime();

  if (elapsed < MINUTE) return 'Just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;

  const then = gymParts(at).date;
  const today = gymParts(now).date;
  const days = civilDaysBetween(then as CivilDate, today as CivilDate);

  if (days <= 0) return `${Math.floor(elapsed / HOUR)} hr ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return shortWeekday(then);

  const dayMonth = shortDay(then).slice(shortWeekday(then).length + 1); // "16 Sep"
  return then.slice(0, 4) === today.slice(0, 4) ? dayMonth : `${dayMonth} ${then.slice(0, 4)}`;
}

/** "Thu 24 Sep 2026, 7:05 AM" — the full stamp, for `title` and screen readers. */
export function absoluteTime(iso: string): string {
  const day = gymParts(iso).date;
  return `${shortDay(day)} ${day.slice(0, 4)}, ${gymClock12(iso)}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
