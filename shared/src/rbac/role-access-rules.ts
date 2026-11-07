import { PERMISSIONS } from '../constants/permissions';
import type { AssignableRoleName, RoleName } from './role-hierarchy';

/**
 * WHO MAY EDIT WHAT A ROLE CAN DO — Staff & Access → "Edit role access"
 * (feat/role-access-editor, owner 2026-11-07).
 *
 * One pure module, two runtimes, like `role-hierarchy.ts`: the API enforces
 * these rules on `PUT /admin/roles/:role/permissions` and the console uses the
 * same functions to decide which role tabs it unlocks, so the screen never
 * offers an edit the server will refuse.
 *
 * Owner decisions (2026-11-07, "just propose the whole design"):
 *   - an ADMIN edits Front desk and Coach;
 *   - only the Super Admin (DEV) edits Admin and Member;
 *   - nobody edits the Super Admin, which always holds everything;
 *   - the keys an Admin needs to reach this editor are locked on for ADMIN,
 *     so no save can lock the gym's admins out of it.
 */

/** Which roles' grants `actor` may change, in the console's tab order. */
export function editableAccessRoles(actor: RoleName): AssignableRoleName[] {
  if (actor === 'DEV') return ['FRONT_DESK', 'COACH', 'ADMIN', 'CLIENT'];
  if (actor === 'ADMIN') return ['FRONT_DESK', 'COACH'];
  return [];
}

export function canEditRoleAccess(actor: RoleName, role: RoleName): boolean {
  return (editableAccessRoles(actor) as RoleName[]).includes(role);
}

/**
 * Locked ON for ADMIN. Staff & Access is reached through `staff.invite`, and
 * this editor through `role.permissions.update`; the rest is what those two
 * require (`server/src/rbac/permission-registry.ts`), so the set is closed —
 * a spec there asserts it.
 */
export const ADMIN_LOCKED_PERMISSIONS: readonly string[] = Object.freeze([
  PERMISSIONS.STAFF_INVITE,
  PERMISSIONS.MEMBER_READ,
  PERMISSIONS.ROLE_CHANGE,
  PERMISSIONS.ROLE_READ,
  PERMISSIONS.ROLE_PERMISSIONS_UPDATE,
  PERMISSIONS.PERMISSION_READ,
]);

/** Whether `key` may not be turned off for `role`. */
export function isLockedForRole(role: RoleName, key: string): boolean {
  return role === 'ADMIN' && ADMIN_LOCKED_PERMISSIONS.includes(key);
}

/** A save's reason: the same 3–200 bound as every other reason in the API. */
export const ROLE_ACCESS_REASON_MIN = 3;
export const ROLE_ACCESS_REASON_MAX = 200;
