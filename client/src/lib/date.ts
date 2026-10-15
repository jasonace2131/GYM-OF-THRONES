import type { CivilDate } from '@got/shared';

/**
 * DEVICE-local civil date. Deliberately NOT gym-local.
 *
 * This exists for one purpose: the still-mock schedule and booking fixtures in
 * portalData.ts, which build a week around the browser's own "today" and have
 * no server to ask. It replaces the deleted `iso()`, which used UTC accessors
 * and therefore attributed every 00:00–08:00 Manila moment to the previous
 * calendar day.
 *
 * Anything that decides entitlement, attendance or expiry must use
 * gymTime.gymToday(now, GYM_TIMEZONE) instead — or, better, must not compute a
 * business day in the browser at all (spec 3.3 rule 1: the server decides, the
 * client formats).
 */
export function localCivilDate(d: Date): CivilDate {
  const year = d.getFullYear().toString().padStart(4, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}` as CivilDate;
}
