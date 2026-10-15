/**
 * The bell's count, as a pill and as words.
 *
 * The pill is decoration (`aria-hidden`) and caps at "9+"; the WORDS carry the
 * meaning and the real number. A badge announced as a bare "3" tells a screen
 * reader user nothing about what there are three of.
 */
export interface UnreadBadge {
  /** What the red pill shows, or `null` for no pill at all. */
  text: string | null;
  /** The same fact as a complete phrase. */
  spoken: string;
}

/**
 * What the bell counts, by surface.
 *
 * The member portal's bell carries the gym's announcements AND the member's
 * own notices (a seat that opened up, a class called off), so it says
 * "notifications" (class-booking fixes, 2026-10-11). The console's bell
 * carries announcements only, and the console already has a section called
 * Notifications — the desk's system alerts, under the same bell icon — so
 * there it keeps saying "announcements" rather than be mistaken for that.
 */
export type BellNoun = 'notification' | 'announcement';

export function unreadBadge(count: number, noun: BellNoun = 'notification'): UnreadBadge {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return { text: null, spoken: `No new ${noun}s` };
  return {
    text: n > 9 ? '9+' : String(n),
    spoken: `${n} new ${noun}${n === 1 ? '' : 's'}`,
  };
}

/**
 * The bell's accessible name: the control, then its state — "Notifications,
 * 3 new". Short on purpose: it is read on every focus, and the noun is
 * already in the name.
 */
export function bellLabel(count: number, noun: BellNoun = 'notification'): string {
  const n = Math.max(0, Math.floor(count));
  const name = noun === 'notification' ? 'Notifications' : 'Announcements';
  return `${name}, ${n === 0 ? 'nothing new' : `${n} new`}`;
}

/**
 * Whether a refresh brought a HIGHER count than the server last reported —
 * the one time the bell's polite status region speaks.
 *
 * `previous` is `null` until the first load has landed: the count present when
 * the page appears is already on the badge and in the bell's name, so reading
 * it out again would be noise. A falling count (the member opened the bell)
 * is their own action, and needs no announcement either. Each feed applies
 * this to its own count; the bell speaks once, for both (NotificationBell).
 */
export function countRose(previous: number | null, next: number): boolean {
  return previous !== null && next > previous;
}
