/**
 * THE ONE PERMISSION CHECK THE CLIENT MAKES.
 *
 * Every screen, nav item and button asks this function, so scope means the
 * same thing everywhere. Before it existed there were fourteen hand-built
 * `new Set(me.permissions.map(p => p.key))` copies, every one of them
 * scope-blind, and a separate scope-aware `holds()` in `safeNext.ts` that was
 * the only place OWN and ALL were told apart.
 *
 * Hiding a control is never a security control — every route behind one is
 * permission-checked server-side. This exists so nobody is shown a door the
 * server will refuse to open.
 */

/** A permission as `GET /me` returns it. `scope` may be absent — see `reaches`. */
export interface HeldPermission {
  key: string;
  scope?: string;
}

/**
 * How far a grant must reach.
 *
 * - `ANY` (the default): any grant of the key.
 * - `ALL`: a grant over everybody — what a screen listing other people needs.
 * - `OWN`: a grant over the caller's own rows. An ALL grant reaches those
 *   too, so OWN accepts either and is the same test as ANY; it exists so a
 *   call site can say what it means.
 */
export type ScopeRequirement = 'ALL' | 'OWN' | 'ANY';

export interface PermissionOptions {
  scope?: ScopeRequirement;
}

/** A requirement in a list: a bare key, or a key with its own scope. */
export type PermissionRequirement = string | { permission: string; scope?: ScopeRequirement };

/** An unresolved permission set — `/me` still in flight — is `null`. */
export type PermissionSet = readonly HeldPermission[] | null | undefined;

/**
 * Whether one grant reaches everybody.
 *
 * A grant with NO scope counts as ALL, deliberately. That is the direction
 * the login redirect has always leaned: if a presenter refactor ever stops
 * sending `scope`, staff must stay staff rather than every admin being
 * demoted to the member portal — the reported bug wearing a different hat.
 */
function reachesAll(grant: HeldPermission): boolean {
  return grant.scope !== 'OWN';
}

/**
 * Whether the caller holds `key` at the scope asked for.
 *
 * DENY WHILE LOADING: a `null` or `undefined` set holds nothing, so a screen
 * rendered before `/me` answers shows its skeleton, never the privileged UI.
 */
export function hasPermission(
  permissions: PermissionSet,
  key: string,
  options: PermissionOptions = {},
): boolean {
  if (permissions === null || permissions === undefined) return false;
  const scope = options.scope ?? 'ANY';
  return permissions.some(
    (grant) => grant.key === key && (scope === 'ALL' ? reachesAll(grant) : true),
  );
}

function satisfies(permissions: PermissionSet, requirement: PermissionRequirement): boolean {
  return typeof requirement === 'string'
    ? hasPermission(permissions, requirement)
    : hasPermission(permissions, requirement.permission, { scope: requirement.scope });
}

/** Every requirement holds. Vacuously true for an empty list, like `every` — unless loading. */
export function canAll(
  permissions: PermissionSet,
  requirements: readonly PermissionRequirement[],
): boolean {
  if (permissions === null || permissions === undefined) return false;
  return requirements.every((requirement) => satisfies(permissions, requirement));
}

/** At least one requirement holds. */
export function canAny(
  permissions: PermissionSet,
  requirements: readonly PermissionRequirement[],
): boolean {
  return requirements.some((requirement) => satisfies(permissions, requirement));
}
