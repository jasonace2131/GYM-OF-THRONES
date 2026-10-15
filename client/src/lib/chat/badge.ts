/**
 * A nav item's unread-messages pill, as text and as words (feat/coach-tools).
 *
 * The pill is decoration and caps at "9+"; the words carry the real number
 * for a screen reader, the same split the announcements bell makes.
 */
export function messagesBadge(count: number): { text: string | null; spoken: string } {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (n === 0) return { text: null, spoken: 'no unread messages' };
  return {
    text: n > 9 ? '9+' : String(n),
    spoken: `${n} unread message${n === 1 ? '' : 's'}`,
  };
}
