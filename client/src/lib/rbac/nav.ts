import { hasPermission, type PermissionSet, type ScopeRequirement } from './permissions';

/**
 * What a nav item declares about who may see it.
 *
 * No `permission` means everybody signed in to that surface. `scope` narrows
 * it; when absent, the surface's default applies — ANY in the member portal,
 * ALL in the console, where every screen lists other people.
 */
export interface NavGate {
  permission?: string;
  scope?: ScopeRequirement;
  /**
   * Further keys the caller must ALSO hold, at any scope (feat/coach-tools).
   * For a screen that needs two jobs at once — the coach's Messages inbox is
   * coaching AND chat — so a caller holding only one is not shown a door that
   * opens onto "not for your role".
   */
  requiresAlso?: readonly string[];
}

/**
 * Whether one nav item is shown.
 *
 * Hiding a link is not a security control — every route behind one is
 * permission-checked server-side. It is so nobody is shown a door they cannot
 * open. A gated item stays hidden while `/me` is loading rather than flashing
 * in and out.
 */
export function canSee(
  gate: NavGate,
  permissions: PermissionSet,
  defaultScope: ScopeRequirement = 'ANY',
): boolean {
  if (gate.permission === undefined) return true;
  return (
    hasPermission(permissions, gate.permission, { scope: gate.scope ?? defaultScope }) &&
    (gate.requiresAlso ?? []).every((key) => hasPermission(permissions, key))
  );
}

export function filterNavItems<T extends NavGate>(
  items: readonly T[],
  permissions: PermissionSet,
  defaultScope: ScopeRequirement = 'ANY',
): T[] {
  return items.filter((item) => canSee(item, permissions, defaultScope));
}

/** Only the groups with at least one item this caller can use. */
export function filterNavGroups<G extends { items: readonly NavGate[] }>(
  groups: readonly G[],
  permissions: PermissionSet,
  defaultScope: ScopeRequirement = 'ANY',
): G[] {
  return groups
    .map((group) => ({ ...group, items: filterNavItems(group.items, permissions, defaultScope) }))
    .filter((group) => group.items.length > 0);
}
