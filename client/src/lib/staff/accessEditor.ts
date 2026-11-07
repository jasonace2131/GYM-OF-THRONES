import { isLockedForRole } from '@got/shared';
import type { GrantScope, PermissionCatalogue, PermissionDefinitionView } from './roleMatrix';

/**
 * Staff & Access → "Edit role access" — the editor's pure half
 * (feat/role-access-editor, owner 2026-11-07).
 *
 * The read-only "What each role can do" table stays as it was; this drives the
 * separate editor beside it. Every rule here is the server's rule asked in
 * advance (`server/src/rbac/role-access.ts`); the server still checks them all.
 */

export type AccessRole = 'FRONT_DESK' | 'COACH' | 'ADMIN' | 'CLIENT';

export interface Grant {
  key: string;
  scope: GrantScope;
}

/** `GET /admin/roles/permissions`, one role. */
export interface RoleAccessRoleView {
  role: AccessRole;
  editable: boolean;
  grants: Grant[];
  defaults: Grant[];
  lastChange: { at: string; byName: string } | null;
}

export interface RoleAccessView {
  roles: RoleAccessRoleView[];
  scopableKeys: string[];
}

/** A role's set while it is being edited: key → reach. */
export type Draft = Record<string, GrantScope>;

export interface AccessChange {
  added: Grant[];
  removed: string[];
  changed: Array<{ key: string; from: GrantScope; to: GrantScope }>;
}

export function toDraft(grants: readonly Grant[]): Draft {
  const draft: Draft = {};
  for (const grant of grants) {
    if (draft[grant.key] !== 'ALL') draft[grant.key] = grant.scope;
  }
  return draft;
}

export function fromDraft(draft: Draft): Grant[] {
  return Object.entries(draft)
    .map(([key, scope]) => ({ key, scope }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function definitionsByKey(
  catalogue: PermissionCatalogue,
): Map<string, PermissionDefinitionView> {
  return new Map(
    Object.values(catalogue)
      .flat()
      .map((def) => [def.key, def]),
  );
}

/**
 * The reach a key gets when it is switched on: the role's own default if it
 * has one, otherwise Own where the app scopes the key (the narrower choice),
 * otherwise All.
 */
export function initialScope(
  key: string,
  defaults: Draft,
  scopable: ReadonlySet<string>,
): GrantScope {
  return defaults[key] ?? (scopable.has(key) ? 'OWN' : 'ALL');
}

/** Switch `key` on, with everything it needs. `alsoOn` lists what came with it. */
export function turnOn(
  draft: Draft,
  key: string,
  defs: Map<string, PermissionDefinitionView>,
  defaults: Draft,
  scopable: ReadonlySet<string>,
): { draft: Draft; alsoOn: string[] } {
  const next: Draft = { ...draft };
  const alsoOn: string[] = [];
  const visit = (current: string, isPrerequisite: boolean): void => {
    if (next[current] !== undefined) return;
    next[current] = initialScope(current, defaults, scopable);
    if (isPrerequisite) alsoOn.push(current);
    for (const req of defs.get(current)?.requires ?? []) visit(req, true);
  };
  visit(key, false);
  return { draft: next, alsoOn: alsoOn.sort() };
}

/** Switch `key` off, and whatever needs it. `alsoOff` lists what went with it. */
export function turnOff(
  draft: Draft,
  key: string,
  defs: Map<string, PermissionDefinitionView>,
): { draft: Draft; alsoOff: string[] } {
  const next: Draft = { ...draft };
  const alsoOff: string[] = [];
  const visit = (current: string, isDependent: boolean): void => {
    if (next[current] === undefined) return;
    delete next[current];
    if (isDependent) alsoOff.push(current);
    for (const held of Object.keys(next)) {
      if ((defs.get(held)?.requires ?? []).includes(current)) visit(held, true);
    }
  };
  visit(key, false);
  return { draft: next, alsoOff: alsoOff.sort() };
}

export function diffDraft(before: Draft, after: Draft): AccessChange {
  const change: AccessChange = { added: [], removed: [], changed: [] };
  for (const [key, scope] of Object.entries(after)) {
    const was = before[key];
    if (was === undefined) change.added.push({ key, scope });
    else if (was !== scope) change.changed.push({ key, from: was, to: scope });
  }
  for (const key of Object.keys(before)) {
    if (after[key] === undefined) change.removed.push(key);
  }
  change.added.sort((a, b) => a.key.localeCompare(b.key));
  change.removed.sort();
  change.changed.sort((a, b) => a.key.localeCompare(b.key));
  return change;
}

export function changeCount(change: AccessChange): number {
  return change.added.length + change.removed.length + change.changed.length;
}

/** Keys whose state differs from `before` — the "Changed" pill and filter. */
export function changedKeys(change: AccessChange): Set<string> {
  return new Set([
    ...change.added.map((g) => g.key),
    ...change.removed,
    ...change.changed.map((c) => c.key),
  ]);
}

/** The dangerous keys this change grants or widens to All — they need a second yes. */
export function dangerousGrants(
  change: AccessChange,
  defs: Map<string, PermissionDefinitionView>,
): string[] {
  return [
    ...change.added.map((g) => g.key),
    ...change.changed.filter((c) => c.to === 'ALL').map((c) => c.key),
  ]
    .filter((key) => defs.get(key)?.isDangerous === true)
    .sort();
}

const covers = (held: GrantScope | undefined, scope: GrantScope): boolean =>
  held !== undefined && (scope === 'OWN' || held === 'ALL');

/**
 * Whether the caller may switch `key` on at `scope` for this role: they hold
 * it themselves, or it is the role's own default. Mirrors the server's
 * no-escalation rule.
 */
export function canGrant(
  key: string,
  scope: GrantScope,
  actorHeld: Draft,
  defaults: Draft,
): boolean {
  return covers(actorHeld[key], scope) || covers(defaults[key], scope);
}

/** What a switch can do for this role right now, and why not. */
export function rowLock(
  role: AccessRole,
  key: string,
  on: boolean,
  actorHeld: Draft,
  defaults: Draft,
): 'locked' | 'not-yours' | null {
  if (on && isLockedForRole(role, key)) return 'locked';
  if (!on && !canGrant(key, 'OWN', actorHeld, defaults)) return 'not-yours';
  return null;
}

export type RowFilter = 'all' | 'on' | 'changed';

/** The catalogue's groups, narrowed by the search box and the filter chips. */
export function visibleGroups(
  catalogue: PermissionCatalogue,
  query: string,
  filter: RowFilter,
  draft: Draft,
  changed: ReadonlySet<string>,
): Array<{ resource: string; rows: PermissionDefinitionView[] }> {
  const q = query.trim().toLowerCase();
  return Object.entries(catalogue)
    .map(([resource, defs]) => ({
      resource,
      rows: defs.filter((def) => {
        if (filter === 'on' && draft[def.key] === undefined) return false;
        if (filter === 'changed' && !changed.has(def.key)) return false;
        if (q === '') return true;
        return (
          def.description.toLowerCase().includes(q) ||
          def.key.toLowerCase().includes(q) ||
          resource.toLowerCase().includes(q)
        );
      }),
    }))
    .filter((group) => group.rows.length > 0);
}

/** "Payments", "Check-in", … — the resource as a heading. */
export function resourceHeading(resource: string): string {
  const words = resource.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
