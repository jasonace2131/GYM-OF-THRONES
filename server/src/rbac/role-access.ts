import type { PermissionScope, Role } from '@prisma/client';
import { ADMIN_LOCKED_PERMISSIONS, isLockedForRole } from '@got/shared';
import { ROLE_PERMISSIONS } from './permission-registry';
import type { PermissionDefinition, PermissionGrant } from './permission-registry';

/**
 * EDIT ROLE ACCESS — the pure half (feat/role-access-editor, owner 2026-11-07).
 *
 * Nothing here reads a database or a clock. The seed uses `applyOverrides` and
 * `closeOverPrerequisites` to write `RolePermission`; the service uses the rest
 * to check a save before it writes anything.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE MODEL: DEFAULTS + DIFFERENCES.
 *
 * `ROLE_PERMISSIONS` (code) is each role's default set. `RolePermissionOverride`
 * holds only where the gym's set differs: a key at a scope (added, or reach
 * changed) or a key at null (a default removed). Live grants are the defaults
 * with the differences laid over them, so a deploy that adds a permission
 * gives it to the right roles at once, and never undoes an edit.
 * ─────────────────────────────────────────────────────────────────────────
 */

export type EditableRole = Exclude<Role, 'DEV'>;

/** One stored difference from the default. `scope: null` is "removed". */
export interface GrantOverride {
  key: string;
  scope: PermissionScope | null;
}

export interface ScopeChange {
  key: string;
  from: PermissionScope;
  to: PermissionScope;
}

export interface GrantDiff {
  added: PermissionGrant[];
  removed: string[];
  changed: ScopeChange[];
}

/**
 * The keys the app limits to a person's own records (or a coach's assigned
 * members): every key some role holds at OWN by default. Everywhere else the
 * reach is ALL and the editor offers on or off only.
 */
export const SCOPABLE_PERMISSION_KEYS: ReadonlySet<string> = new Set(
  Object.values(ROLE_PERMISSIONS)
    .flat()
    .filter((grant) => grant.scope === 'OWN')
    .map((grant) => grant.key),
);

function toMap(grants: readonly PermissionGrant[]): Map<string, PermissionScope> {
  const map = new Map<string, PermissionScope>();
  for (const grant of grants) {
    // Two grants of one key resolve to the wider, as PermissionsService does.
    if (map.get(grant.key) !== 'ALL') map.set(grant.key, grant.scope);
  }
  return map;
}

function fromMap(map: Map<string, PermissionScope>): PermissionGrant[] {
  return [...map.entries()]
    .map(([key, scope]) => ({ key, scope }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Live grants: the defaults with the gym's differences laid over them. */
export function applyOverrides(
  defaults: readonly PermissionGrant[],
  overrides: readonly GrantOverride[],
): PermissionGrant[] {
  const map = toMap(defaults);
  for (const override of overrides) {
    if (override.scope === null) map.delete(override.key);
    else map.set(override.key, override.scope);
  }
  return fromMap(map);
}

/** The differences to store so that defaults + differences = `desired`. */
export function overridesFor(
  defaults: readonly PermissionGrant[],
  desired: readonly PermissionGrant[],
): GrantOverride[] {
  const base = toMap(defaults);
  const want = toMap(desired);
  const keys = new Set([...base.keys(), ...want.keys()]);
  const out: GrantOverride[] = [];
  for (const key of keys) {
    const from = base.get(key) ?? null;
    const to = want.get(key) ?? null;
    if (from !== to) out.push({ key, scope: to });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function diffGrants(
  before: readonly PermissionGrant[],
  after: readonly PermissionGrant[],
): GrantDiff {
  const was = toMap(before);
  const now = toMap(after);
  const diff: GrantDiff = { added: [], removed: [], changed: [] };
  for (const [key, scope] of now) {
    const previous = was.get(key);
    if (previous === undefined) diff.added.push({ key, scope });
    else if (previous !== scope) diff.changed.push({ key, from: previous, to: scope });
  }
  for (const key of was.keys()) {
    if (!now.has(key)) diff.removed.push(key);
  }
  diff.added.sort((a, b) => a.key.localeCompare(b.key));
  diff.removed.sort();
  diff.changed.sort((a, b) => a.key.localeCompare(b.key));
  return diff;
}

export function isEmptyDiff(diff: GrantDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/**
 * The SEED's safety net, fail-closed: drop every key whose prerequisites are
 * not all held, repeating until nothing changes.
 *
 * The API refuses a set that breaks the closure, so this only bites when the
 * CODE later gives a key a new prerequisite that a stored edit lacks. Dropping
 * the dependent key (rather than adding the prerequisite) never widens access,
 * and a seed that threw instead would fail the deploy over a gym setting.
 */
export function closeOverPrerequisites(
  catalogue: readonly PermissionDefinition[],
  grants: readonly PermissionGrant[],
): { kept: PermissionGrant[]; dropped: string[] } {
  const requires = new Map(catalogue.map((def) => [def.key, def.requires]));
  const map = toMap(grants);
  const dropped: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...map.keys()]) {
      const needs = requires.get(key) ?? [];
      if (needs.some((req) => !map.has(req))) {
        map.delete(key);
        dropped.push(key);
        changed = true;
      }
    }
  }
  return { kept: fromMap(map), dropped: dropped.sort() };
}

/** Why a save is refused, with the keys that caused it. */
export type RoleAccessRefusal =
  | { code: 'UNKNOWN_PERMISSION'; keys: string[] }
  | { code: 'SCOPE_NOT_SUPPORTED'; keys: string[] }
  | { code: 'PREREQUISITE_MISSING'; keys: string[] }
  | { code: 'LOCKED'; keys: string[] }
  | { code: 'ESCALATION'; keys: string[] }
  | { code: 'CONFIRM_REQUIRED'; keys: string[] };

export interface RoleAccessCheck {
  role: EditableRole;
  /** The role's live grants now. */
  before: readonly PermissionGrant[];
  /** The code's defaults for the role. Giving one back is never escalation. */
  defaults: readonly PermissionGrant[];
  /** The full set the caller wants the role to hold. */
  desired: readonly PermissionGrant[];
  catalogue: readonly PermissionDefinition[];
  /** What the CALLER holds. DEV's resolved set is every key at ALL. */
  actorHeld: readonly PermissionGrant[];
  confirm: boolean;
}

/**
 * Every rule a save must pass, in the order a person would fix them: a key
 * that does not exist, a reach the key does not have, a missing prerequisite,
 * a locked key turned off, a key the caller cannot hand out, and last the
 * extra confirmation for a dangerous grant. Null when the save may go ahead.
 *
 * Whether the caller may edit this ROLE at all is `canEditRoleAccess`, checked
 * by the service before this runs.
 */
export function checkRoleAccess(input: RoleAccessCheck): RoleAccessRefusal | null {
  const defs = new Map(input.catalogue.map((def) => [def.key, def]));
  const desired = toMap(input.desired);

  const unknown = [...desired.keys()].filter((key) => !defs.has(key));
  if (unknown.length > 0) return { code: 'UNKNOWN_PERMISSION', keys: unknown.sort() };

  const unscoped = [...desired.entries()]
    .filter(([key, scope]) => scope === 'OWN' && !SCOPABLE_PERMISSION_KEYS.has(key))
    .map(([key]) => key);
  if (unscoped.length > 0) return { code: 'SCOPE_NOT_SUPPORTED', keys: unscoped.sort() };

  const missing = [...desired.keys()].filter((key) =>
    (defs.get(key)?.requires ?? []).some((req) => !desired.has(req)),
  );
  if (missing.length > 0) return { code: 'PREREQUISITE_MISSING', keys: missing.sort() };

  const locked = ADMIN_LOCKED_PERMISSIONS.filter(
    (key) => isLockedForRole(input.role, key) && !desired.has(key),
  );
  if (locked.length > 0) return { code: 'LOCKED', keys: [...locked].sort() };

  // Only what this save ADDS or WIDENS. A key the role already holds may stay
  // even if the caller lacks it: keeping is not handing out. And a role's own
  // default may always come back, or an Admin who turned off a coach-only key
  // (one ADMIN does not hold) could never turn it on again, nor reset.
  const diff = diffGrants(input.before, input.desired);
  const granted = [
    ...diff.added,
    ...diff.changed
      .filter((change) => change.to === 'ALL')
      .map((c) => ({ key: c.key, scope: c.to })),
  ];
  const actor = toMap(input.actorHeld);
  const defaults = toMap(input.defaults);
  const covers = (held: PermissionScope | undefined, scope: PermissionScope): boolean =>
    held !== undefined && (scope === 'OWN' || held === 'ALL');
  const escalating = granted
    .filter(
      (grant) =>
        !covers(actor.get(grant.key), grant.scope) && !covers(defaults.get(grant.key), grant.scope),
    )
    .map((grant) => grant.key);
  if (escalating.length > 0) return { code: 'ESCALATION', keys: escalating.sort() };

  const dangerous = granted.filter((grant) => defs.get(grant.key)?.isDangerous).map((g) => g.key);
  if (dangerous.length > 0 && !input.confirm) {
    return { code: 'CONFIRM_REQUIRED', keys: dangerous.sort() };
  }

  return null;
}
