import type { PlanGuidance } from '@got/shared';
import type { CivilDate } from '@/lib/gymTime';

/**
 * Day of the year for a civil date, 1-366. Split and reassembled through UTC
 * so no time zone can move a Manila day into yesterday.
 */
export function dayOfYear(day: CivilDate): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const start = Date.UTC(y, 0, 1);
  const at = Date.UTC(y, m - 1, d);
  return Math.round((at - start) / 86_400_000) + 1;
}

/**
 * "Today's wellness tip" on the hub: the active plan's guidance, one entry a
 * day, rotating with the calendar so a member who opens the app daily reads
 * each tip in turn rather than the same first one.
 */
export function tipOfTheDay(
  guidance: readonly PlanGuidance[],
  today: CivilDate,
): PlanGuidance | null {
  if (guidance.length === 0) return null;
  return guidance[dayOfYear(today) % guidance.length] ?? null;
}
