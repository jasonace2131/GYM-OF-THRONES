/**
 * Everything about the signed-in member that this app writes to device storage.
 *
 * The registry is the point: `signOut` clears this list, so adding a cached
 * member field means adding its key here in the same commit. Without it a
 * shared or resold phone renders the previous member's name, code and photo on
 * a card that is designed to be handed to staff.
 *
 * Supabase's own `sb-*` session keys are NOT listed — `supabase.auth.signOut()`
 * owns those, and clearing them from underneath it breaks its own teardown.
 */
export const MEMBER_DEVICE_CACHE_KEYS: readonly string[] = [
  'got.member.profile',
  'got.member.membership',
  'got.member.checkinStatus',
  // The open workout and its not-yet-sent sets (lib/workouts/sessionCache.ts,
  // lib/workouts/syncQueue.ts). Unsent sets are lost on sign-out by design:
  // the next person on this phone must not see — or replay — someone else's.
  'got.workouts.session.v1',
  'got.workouts.sync.v1',
];

export function clearMemberDeviceCache(): void {
  if (typeof window === 'undefined') return;

  for (const key of MEMBER_DEVICE_CACHE_KEYS) {
    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
  }
}
