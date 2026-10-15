import {
  ROLE_RANK,
  accountActionRefusal,
  assignableRoles,
  roleChangeRefusal,
  roleLabel,
  type AccountAction,
  type AssignableRoleName,
  type HierarchyTarget,
  type RoleName,
  type RoleRuleRefusal,
} from '@got/shared';

/**
 * WHICH ROW ACTIONS THE CONSOLE OFFERS, AND HOW.
 *
 * The rules are `@got/shared`'s role hierarchy — the SAME functions the API
 * enforces — so the console never offers a click the server will refuse. This
 * module only decides how each refusal is PRESENTED (owner decision, and the
 * research behind it):
 *
 *   - an action the caller can NEVER take is HIDDEN: an ADMIN is not shown
 *     "Change role" on another ADMIN, nor anything on the Super Admin;
 *   - an action blocked by the CURRENT state is DISABLED WITH A REASON: "this
 *     is your own account", "this is the last active admin". Those are the
 *     two a person reasonably goes looking for, and a missing button would
 *     leave them wondering whether the console is broken.
 *
 * Presentation, not enforcement. The server is the authority on every one.
 */

export type ActionAvailability =
  { state: 'hidden' } | { state: 'disabled'; reason: string } | { state: 'enabled' };

/** The caller, as `/me` gives it. Null while `/me` is loading. */
export interface CallerFacts {
  id: string;
  role: string;
}

/** A roster row, as far as the hierarchy needs it. */
export interface AccountFacts {
  id: string;
  role: string;
  status: string;
  deletedAt: string | null;
}

const ROLES = Object.keys(ROLE_RANK) as RoleName[];

/** Narrow a role string off the wire; anything unknown is refused, never guessed. */
export function toRoleName(role: string | null | undefined): RoleName | null {
  return role !== null && role !== undefined && (ROLES as string[]).includes(role)
    ? (role as RoleName)
    : null;
}

/** Active ADMIN accounts on the list — what the last-admin rule counts. */
export function countActiveAdmins(rows: readonly AccountFacts[]): number {
  return rows.filter((row) => row.role === 'ADMIN' && isActive(row)).length;
}

function isActive(row: AccountFacts): boolean {
  return row.status === 'ACTIVE' && row.deletedAt === null;
}

function target(row: AccountFacts): HierarchyTarget | null {
  const role = toRoleName(row.role);
  return role === null ? null : { id: row.id, role, active: isActive(row) };
}

const SELF_REASON = 'This is your own account. Another admin has to change it.';
const LAST_ADMIN_REASON = 'This is the last active admin. Make somebody else an admin first.';

function present(refusal: RoleRuleRefusal | null): ActionAvailability {
  switch (refusal) {
    case null:
      return { state: 'enabled' };
    case 'SELF':
      return { state: 'disabled', reason: SELF_REASON };
    case 'LAST_ADMIN':
      return { state: 'disabled', reason: LAST_ADMIN_REASON };
    case 'DEV_PROTECTED':
    case 'TARGET_OUTRANKS':
    case 'ROLE_NOT_ASSIGNABLE':
      return { state: 'hidden' };
  }
}

/**
 * "Change role" on one row.
 *
 * Enabled when at least ONE other role could be given. Disabled for the last
 * admin only when every alternative is refused for that reason — which, since
 * every alternative to ADMIN is a demotion, is exactly when they are the last.
 */
export function roleChangeAvailability(
  caller: CallerFacts | null,
  row: AccountFacts,
  options: { canChange: boolean; activeAdmins?: number },
): ActionAvailability {
  if (!options.canChange || caller === null) return { state: 'hidden' };
  const actorRole = toRoleName(caller.role);
  const subject = target(row);
  if (actorRole === null || subject === null) return { state: 'hidden' };

  const alternatives = assignableRoles(actorRole).filter((role) => role !== subject.role);
  if (alternatives.length === 0) {
    // Nothing to offer — unless that is because it is their own row, which
    // still deserves its reason.
    return subject.id === caller.id ? present('SELF') : { state: 'hidden' };
  }

  const refusals = alternatives.map((newRole) =>
    roleChangeRefusal({
      actor: { id: caller.id, role: actorRole },
      target: subject,
      newRole,
      activeAdmins: options.activeAdmins,
    }),
  );
  if (refusals.some((refusal) => refusal === null)) return { state: 'enabled' };
  return present(refusals[0] ?? null);
}

/** Suspend, reactivate, delete or restore on one row. */
export function accountActionAvailability(
  caller: CallerFacts | null,
  row: AccountFacts,
  action: AccountAction,
  options: { allowed: boolean; activeAdmins?: number },
): ActionAvailability {
  if (!options.allowed || caller === null) return { state: 'hidden' };
  const actorRole = toRoleName(caller.role);
  const subject = target(row);
  if (actorRole === null || subject === null) return { state: 'hidden' };

  return present(
    accountActionRefusal({
      actor: { id: caller.id, role: actorRole },
      target: subject,
      action,
      activeAdmins: options.activeAdmins,
    }),
  );
}

export interface RoleOption {
  value: AssignableRoleName;
  label: string;
}

/** What a role picker offers this caller, in rank order. */
export function roleOptionsFor(callerRole: string | null | undefined): RoleOption[] {
  const role = toRoleName(callerRole);
  if (role === null) return [];
  return assignableRoles(role).map((value) => ({ value, label: roleLabel(value) }));
}
