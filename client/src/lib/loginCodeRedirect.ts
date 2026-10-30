/**
 * Where a page goes when the API answers `401 LOGIN_CODE_REQUIRED`: this
 * sign-in has not entered its emailed code yet. Pure, so `apiFetch`'s rule is
 * testable without a browser navigation.
 */
export const LOGIN_CODE_REQUIRED = 'LOGIN_CODE_REQUIRED';

/**
 * The one-device rule's error code. Defined here, beside LOGIN_CODE_REQUIRED,
 * because this module imports nothing: `loginCode.ts` needs only the string,
 * and reaching it through `sessionReplaced.ts` would drag the Supabase client
 * into every module (and test) that classifies a `/me` failure.
 */
export const SESSION_REPLACED = 'SESSION_REPLACED';

/**
 * Pages that deal with an unverified sign-in themselves: the login page shows
 * the code step, and the join/reset pages run on email-link sessions, which
 * the server already counts as verified (a password session that reaches
 * /join gets its own sign-out copy there, since /join is not a `?next=`).
 *
 * `/invite` is NOT here: "sign in instead" signs in by password, so the page
 * can meet an unverified session, and `safeNext` allows `/invite` — the
 * round trip through the code step lands back on the invitation.
 */
const SELF_HANDLING_ROOTS = ['/login', '/join', '/reset-password', '/register'] as const;

/**
 * The public landing page, matched EXACTLY. Its Navbar asks `/me` on mount
 * only to label a "My portal" / "Staff console" button, and a visitor with a
 * half-finished sign-in must not be pulled off the homepage for it — the
 * button takes them to /login, which shows the code step. `/register` is in
 * the list above for the same reason: it routes a signed-in visitor itself.
 */
const SELF_HANDLING_EXACT = ['/'] as const;

/**
 * Whether this page deals with a signed-in (or no-longer-signed-in) visitor
 * itself, so a redirect to /login would only get in its way. Shared with the
 * one-device rule's redirect (`sessionReplaced.ts`).
 */
export function handlesSignInItself(pathname: string): boolean {
  return (
    SELF_HANDLING_EXACT.some((path) => pathname === path) ||
    SELF_HANDLING_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`))
  );
}

/** `/login?next=<this page>`, or null when this page handles the code itself. */
export function loginCodeRedirectFor(pathname: string, search: string): string | null {
  if (handlesSignInItself(pathname)) return null;
  return `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
}

/** The navigation seam: tests spy on `assign`; the app does a real full-page load. */
export const browserNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};
