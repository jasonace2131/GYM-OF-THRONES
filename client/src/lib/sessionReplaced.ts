'use client';

import { signOutMember } from './memberSignOut';
import { SESSION_REPLACED, browserNavigation, handlesSignInItself } from './loginCodeRedirect';

/**
 * ONE DEVICE AT A TIME (owner, 2026-10-30).
 *
 * When an account signs in on another device, the API answers this device's
 * next request `401 SESSION_REPLACED`. The newest sign-in wins; this device
 * must forget its sign-in and say why.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SIGN-OUT HERE IS LOCAL, NEVER GLOBAL.
 *
 * `supabase.auth.signOut()` with no scope is GLOBAL: it ends every sign-in of
 * the account, including the new device's, which would then be answered
 * "signed in elsewhere" by nobody and simply logged out. The person who just
 * signed in on their new phone must not lose it because their old laptop woke
 * up. `{ scope: 'local' }` ends only the sign-in this browser holds.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export { SESSION_REPLACED };

/** `/login?reason=replaced`: the login page shows SESSION_REPLACED_MESSAGE. */
export const SESSION_REPLACED_REASON = 'replaced';

/** The same words as the server's error message. */
export const SESSION_REPLACED_MESSAGE =
  'You were signed out because your account signed in on another device.';

/**
 * `/login?reason=replaced&next=<this page>`, or null on a page that deals with
 * a signed-out visitor itself (the login page, the public landing page, the
 * join, register and reset pages). Pure, so the rule is testable.
 */
export function sessionReplacedRedirectFor(pathname: string, search: string): string | null {
  if (handlesSignInItself(pathname)) return null;
  return replacedLoginPath(`${pathname}${search}`);
}

function replacedLoginPath(next: string): string {
  return `/login?reason=${SESSION_REPLACED_REASON}&next=${encodeURIComponent(next)}`;
}

/** Set while this page is signing out a replaced sign-in. */
let replacing: Promise<void> | null = null;

/**
 * Whether this page is signing out because another device took the account.
 *
 * The portal and console shells each send a signed-out visitor to `/login`
 * themselves, and they notice this sign-out a moment before the redirect
 * below happens. They ask this, and go to the same `?reason=replaced` address
 * instead of their plain one, so whichever navigation lands first the login
 * page shows the reason.
 */
export function sessionWasReplaced(): boolean {
  return replacing !== null;
}

/** Where a shell sends a visitor who is no longer signed in. */
export function signedOutLoginPath(pathname: string, search: string): string {
  const next = `${pathname}${search}`;
  return sessionWasReplaced() ? replacedLoginPath(next) : `/login?next=${encodeURIComponent(next)}`;
}

/**
 * Forget this device's sign-in after `SESSION_REPLACED`: clear the member's
 * device cache, sign out LOCALLY, then load `/login?reason=replaced`.
 *
 * ONCE, however many requests fail together: a page that fires five calls on
 * mount gets five 401s, and all of them share this one sign-out and one
 * navigation. The address is worked out from the page the failure happened
 * on, before anything moves. A full page load, not a router push, so nothing
 * held in memory for the old sign-in (the chat socket, cached screens)
 * survives it.
 *
 * On a page that handles sign-in itself there is no navigation, and the flag
 * is cleared once the sign-out is done: the login page shows the notice from
 * its own failed `/me`, and a later sign-in on this same page must start
 * clean.
 */
export function signOutReplacedSession(): Promise<void> {
  if (replacing !== null) return replacing;
  const target =
    typeof window === 'undefined'
      ? null
      : sessionReplacedRedirectFor(window.location.pathname, window.location.search);

  replacing = (async () => {
    await signOutMember('local');
    if (target !== null) {
      // The page is unloading; the flag stays set so nothing else redirects.
      browserNavigation.assign(target);
      return;
    }
    replacing = null;
  })();
  return replacing;
}
