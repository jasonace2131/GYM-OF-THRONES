import { hasPermission, type HeldPermission } from './rbac/permissions';

/** Where a member goes when nothing better is known. */
export const MEMBER_HOME = '/portal/dashboard';
/**
 * Where a coach goes when nothing better is known: their own dashboard. The
 * same URL as a member's — /portal/dashboard renders the coach view for a coach
 * (owner, 2026-10-06: one dashboard, not two). /portal/coaching redirects here.
 */
export const COACH_HOME = '/portal/dashboard';
/** Where a staff account goes when nothing better is known. */
export const STAFF_HOME = '/admin';
/** The wall-mounted station display. Not a `homeFor()` answer — see SURFACES. */
export const DESK_HOME = '/desk/station';

/**
 * A permission as `GET /me` returns it.
 *
 * `scope` is optional because two call sites hand this function a projection
 * that predates scoping. Absent scope is treated as ALL — see `holds()` for
 * why that direction is the safe one. Re-exported from the one permission
 * module so existing imports keep working.
 */
export type { HeldPermission };

/**
 * THE THREE SIGNED-IN SURFACES, IN ONE TABLE.
 *
 * Before this table, "there are two surfaces" was hard-coded in six places —
 * the allowlist, `homeFor`, the login redirect, the console's own gate, the
 * portal's staff flag and the sidebar's link — and every one of them had to be
 * edited in step. They were not, which is most of why an admin could be sent
 * to the member portal by a link the login screen generated itself.
 *
 * `requires` is the permission key that surface's own server routes gate on,
 * so a `?next=` can never deliver somebody to a shell that will 403 them.
 */
const SURFACES = [
  { root: '/portal', home: MEMBER_HOME, requires: null },
  { root: '/admin', home: STAFF_HOME, requires: 'member.read' },
  { root: '/desk', home: DESK_HOME, requires: 'checkin.create' },
  // Staff & Access: not a surface anybody lives on, but a page a `?next=`
  // must be able to return to — "sign in instead" on a staff invitation comes
  // back here to accept it. No permission: the invitation is the authority,
  // and the server checks the signed-in address against it. Never a home.
  { root: '/invite', home: MEMBER_HOME, requires: null },
] as const;

const ALLOWED_ROOTS = SURFACES.map((surface) => surface.root);

/**
 * Whether a permission set holds a key at a scope that reaches other people.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCOPE IS THE WHOLE POINT, AND IGNORING IT WAS A LIVE BUG.
 *
 * A COACH is granted `member.read` at scope OWN (`permission-registry.ts:251`)
 * so they can read their own profile. Every scope-blind `key === 'member.read'`
 * test therefore classified every coach as staff: they were routed to `/admin`,
 * handed the console shell, and shown a dashboard firing `payment.read` calls
 * that could never succeed for them.
 *
 * Absent scope counts as held. That direction is deliberate: if a presenter
 * refactor ever stops sending `scope`, this degrades to the old behaviour —
 * staff stay staff — rather than demoting every admin to the member portal,
 * which is the reported bug wearing a different hat.
 *
 * It is `hasPermission(…, { scope: 'ALL' })` — the client's one permission
 * check, which carries that same absent-scope rule — so the login redirect
 * and every nav and page gate agree on what ALL means.
 * ─────────────────────────────────────────────────────────────────────────
 */
function holds(permissions: readonly HeldPermission[], key: string): boolean {
  return hasPermission(permissions, key, { scope: 'ALL' });
}

/**
 * Validates a `?next=` return URL against an allowlist, not a denylist.
 *
 * `startsWith('/')` alone is an open redirect: `//evil.example` is a
 * protocol-relative URL, and browsers normalise `/\evil.example` into one too.
 * This is the single most-reported bug class in return-URL flows, which is why
 * it gets one function and one table-driven test rather than an inline check at
 * each call site.
 *
 * Each root is a path-SEGMENT test, not a prefix test — `/portalish` is not
 * inside the portal, and a prefix match would let it in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS USED TO ALLOW ONLY `/portal`, AND THAT WAS A REAL BUG, not a tightening.
 *
 * The admin console redirects an unauthenticated caller to
 * `/login?next=/admin/members`. With `/admin` outside the allowlist that
 * `next` was rewritten to the member portal, so a staff account could never
 * reach the console by being SENT there — sign in, land on the member portal,
 * and conclude the two surfaces are the same product. Widening the allowlist
 * is what makes staff and members distinguishable at all.
 *
 * Validity is not permission. `safeNext` answers "is this a real destination";
 * `destinationFor` answers "may THIS caller open it". Keep them separate.
 * ─────────────────────────────────────────────────────────────────────────
 */
export function safeNext(raw: string | null, fallback: string = MEMBER_HOME): string {
  if (!raw) return fallback;
  if (raw.includes('\\')) return fallback;
  if (raw.startsWith('//')) return fallback;
  // A `..` segment lets a path that starts with an allowed root normalise
  // outside it — `/portal/../evil` passes a prefix check and resolves
  // elsewhere. Same-origin, so not an open redirect, but it voids the
  // "stays inside a known surface" guarantee this function exists to give.
  if (raw.split(/[/?#]/).includes('..')) return fallback;

  const inside = ALLOWED_ROOTS.some((root) => raw === root || raw.startsWith(`${root}/`));
  return inside ? raw : fallback;
}

/**
 * Whether a permission set belongs to staff.
 *
 * `member.read` is the console's floor and is the same key its layout gates
 * on, so the login redirect and the shell can never disagree about who is
 * staff. Deliberately NOT a role test: a role check hard-codes today's grant
 * table into the client and stops agreeing with it the first time a grant is
 * edited.
 */
export function isStaff(permissions: readonly HeldPermission[]): boolean {
  return holds(permissions, 'member.read');
}

/**
 * Whether a permission set belongs to a coach: `coach.read` (granted to COACH
 * at OWN — their own caseload) held by somebody who is not staff.
 *
 * Staff hold `coach.read` at ALL too, but they are going to the console, so
 * the staff test wins. Deliberately not a role test, for the reason `isStaff`
 * gives.
 */
export function isCoach(permissions: readonly HeldPermission[] | null): boolean {
  if (permissions === null) return false;
  return !isStaff(permissions) && hasPermission(permissions, 'coach.read', { scope: 'OWN' });
}

/**
 * Where "home" is INSIDE the member portal — the target of a "go home" link on
 * a portal page. A coach's is their dashboard; everybody else's, staff
 * visiting the portal included, is the member dashboard.
 */
export function portalHomeFor(permissions: readonly HeldPermission[] | null): string {
  return isCoach(permissions) ? COACH_HOME : MEMBER_HOME;
}

/** Where this caller belongs when they did not ask for anywhere in particular. */
export function homeFor(permissions: readonly HeldPermission[]): string {
  return isStaff(permissions) ? STAFF_HOME : portalHomeFor(permissions);
}

/**
 * Whether this caller may open an already-validated destination.
 *
 * A path outside every known surface is not openable — `safeNext` has already
 * replaced those with a fallback, so reaching here with one means a caller
 * passed an unvalidated string and should get the same "no" either way.
 */
export function canOpen(destination: string, permissions: readonly HeldPermission[]): boolean {
  const surface = SURFACES.find(
    (candidate) => destination === candidate.root || destination.startsWith(`${candidate.root}/`),
  );
  if (surface === undefined) return false;
  return surface.requires === null || holds(permissions, surface.requires);
}

/**
 * The one answer the login screen needs: where does THIS caller go now?
 *
 * Validity, then permission, then fall home. A staff member sent to
 * `/admin/members` lands there; a CLIENT handed the same link lands on the
 * member portal rather than on a console that would 403 them; and a CLIENT
 * handed `?next=/desk/station` no longer lands on the wall-mounted kiosk,
 * which has no auth gate of its own by design.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STAFF ARE NEVER DELIVERED TO THE MEMBER PORTAL BY A `?next=`.
 *
 * This rule is the whole reason the first fix did not work, and it is worth
 * stating plainly because "honour the caller's request" sounds obviously
 * right and is wrong here.
 *
 * `portal/layout.tsx` bounces a signed-out visitor to
 * `/login?next=/portal/dashboard`. That `next` is not a request anybody
 * made — it is a machine-generated breadcrumb from whichever page the
 * browser happened to be showing. The portal requires no permission, so a
 * permission check waves it straight through, and an ADMIN who had a portal
 * tab open signs in and lands back on the member dashboard. Verified against
 * the live account: `/me` returned ADMIN with `member.read@ALL`, `isStaff`
 * was true, and `destinationFor('/portal/dashboard', …)` still returned the
 * portal.
 *
 * So a staff `?next=` into `/admin` or `/desk` is honoured — that is how the
 * console returns somebody to the page they were reaching for — and a
 * `?next=` into `/portal` is dropped in favour of the console. Staff signing
 * in are going to work. Their own membership is one labelled click away in
 * the topbar, which is a deliberate act rather than an accident of history.
 * ─────────────────────────────────────────────────────────────────────────
 */
export function destinationFor(raw: string | null, permissions: readonly HeldPermission[]): string {
  const home = homeFor(permissions);
  const destination = safeNext(raw, home);
  if (!canOpen(destination, permissions)) return home;

  const intoPortal = destination === '/portal' || destination.startsWith('/portal/');
  if (intoPortal && isStaff(permissions)) return STAFF_HOME;

  return destination;
}
