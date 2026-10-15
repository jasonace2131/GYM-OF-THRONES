/**
 * THE ROLE HIERARCHY — who may give which role to whom.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE PURE MODULE, TWO RUNTIMES.
 *
 * The API enforces these rules (members.service, staff-invitations.service)
 * and the console uses the SAME functions to decide what to offer, so a role
 * picker can never show an option the server will refuse. Nothing here reads
 * a database or a clock: the callers bring the facts, this decides.
 *
 * Owner decisions (2026-09-25):
 *   - the Super Admin is the existing DEV account;
 *   - only DEV creates, promotes or demotes ADMINs;
 *   - ADMINs add members, front desk and coaches — never another admin;
 *   - nobody changes their own role;
 *   - the last active ADMIN cannot be demoted, suspended or deleted;
 *   - DEV is never assignable.
 *
 * All of that falls out of ONE rule plus two exceptions:
 *
 *   A caller may give a role only if it ranks STRICTLY BELOW their own, and
 *   may act on an account only if its current role ranks strictly below
 *   their own. DEV (rank 3) therefore reaches ADMIN (rank 2), and nobody
 *   reaches DEV. The exceptions are "never yourself" and "never the last
 *   active admin".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is a ROLE test, deliberately, and that is not in tension with "gate on
 * permissions, never on role names". Permissions decide whether a caller may
 * change roles AT ALL (`role.change`, `staff.invite`); the hierarchy decides
 * WHICH roles, and the hierarchy is about roles by definition.
 */

/** Mirrors the Prisma `Role` enum and `UserRole` in user.types.ts. */
export type RoleName = 'CLIENT' | 'FRONT_DESK' | 'COACH' | 'ADMIN' | 'DEV';

/**
 * CLIENT < FRONT_DESK = COACH < ADMIN < DEV.
 *
 * Front desk and coach are EQUAL: neither manages the other, and an ADMIN may
 * move somebody between them in either direction.
 */
export const ROLE_RANK: Readonly<Record<RoleName, number>> = Object.freeze({
  CLIENT: 0,
  FRONT_DESK: 1,
  COACH: 1,
  ADMIN: 2,
  DEV: 3,
});

/** Every role `POST /members/:id/role` can set — all but DEV, in rank order. */
export const ASSIGNABLE_ROLE_NAMES = ['CLIENT', 'FRONT_DESK', 'COACH', 'ADMIN'] as const;
export type AssignableRoleName = (typeof ASSIGNABLE_ROLE_NAMES)[number];

/**
 * What an invitation may carry. Never CLIENT (anyone may register for free)
 * and never DEV (seed or direct database access only).
 */
export const INVITABLE_ROLES = ['FRONT_DESK', 'COACH', 'ADMIN'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export function isInvitableRole(role: string): role is InvitableRole {
  return (INVITABLE_ROLES as readonly string[]).includes(role);
}

function below(role: RoleName, actor: RoleName): boolean {
  return ROLE_RANK[role] < ROLE_RANK[actor];
}

/** Whether `actor` may give somebody `role`. Never DEV; otherwise strictly below. */
export function canAssignRole(actor: RoleName, role: RoleName): boolean {
  return role !== 'DEV' && below(role, actor);
}

/** The roles a role picker may offer this caller, in rank order. */
export function assignableRoles(actor: RoleName): AssignableRoleName[] {
  return ASSIGNABLE_ROLE_NAMES.filter((role) => canAssignRole(actor, role));
}

/** The roles an invite form may offer this caller, in rank order. */
export function invitableRoles(actor: RoleName): InvitableRole[] {
  return INVITABLE_ROLES.filter((role) => canAssignRole(actor, role));
}

/** Whether `actor` may act on an account currently holding `target`. Never a DEV account. */
export function canManageAccount(actor: RoleName, target: RoleName): boolean {
  return target !== 'DEV' && below(target, actor);
}

/**
 * Why a role change or account action is refused.
 *
 * - `SELF` — nobody changes their own role, suspends, reactivates or deletes
 *   themselves.
 * - `DEV_PROTECTED` — the DEV account is never changed through the API.
 * - `TARGET_OUTRANKS` — the account's current role is not below the caller's
 *   (an ADMIN acting on another ADMIN).
 * - `ROLE_NOT_ASSIGNABLE` — the NEW role is not below the caller's (an ADMIN
 *   promoting to ADMIN), or it is DEV.
 * - `LAST_ADMIN` — it would leave no active ADMIN.
 */
export type RoleRuleRefusal =
  'SELF' | 'DEV_PROTECTED' | 'TARGET_OUTRANKS' | 'ROLE_NOT_ASSIGNABLE' | 'LAST_ADMIN';

export interface HierarchyActor {
  id: string;
  role: RoleName;
}

export interface HierarchyTarget {
  id: string;
  role: RoleName;
  /** Status ACTIVE and not soft-deleted — what "active admin" counts. */
  active: boolean;
}

/**
 * How many ADMIN accounts are active right now, counting the target if it is
 * one. `undefined` skips the last-admin rule: the console may not know the
 * number, and the server — which always does — enforces it anyway.
 */
type ActiveAdmins = number | undefined;

/** Removing this account's ADMIN-ness would leave nobody. */
function isLastActiveAdmin(target: HierarchyTarget, activeAdmins: ActiveAdmins): boolean {
  if (activeAdmins === undefined) return false;
  return target.role === 'ADMIN' && target.active && activeAdmins <= 1;
}

function accountRefusal(
  actor: HierarchyActor,
  target: HierarchyTarget,
): 'SELF' | 'DEV_PROTECTED' | 'TARGET_OUTRANKS' | null {
  if (actor.id === target.id) return 'SELF';
  if (target.role === 'DEV') return 'DEV_PROTECTED';
  if (!canManageAccount(actor.role, target.role)) return 'TARGET_OUTRANKS';
  return null;
}

/** `POST /members/:id/role`. Null when the change is allowed. */
export function roleChangeRefusal(input: {
  actor: HierarchyActor;
  target: HierarchyTarget;
  newRole: RoleName;
  activeAdmins?: ActiveAdmins;
}): RoleRuleRefusal | null {
  const refusal = accountRefusal(input.actor, input.target);
  if (refusal !== null) return refusal;
  if (!canAssignRole(input.actor.role, input.newRole)) return 'ROLE_NOT_ASSIGNABLE';
  if (input.newRole !== 'ADMIN' && isLastActiveAdmin(input.target, input.activeAdmins)) {
    return 'LAST_ADMIN';
  }
  return null;
}

/**
 * The four account actions. Suspend and delete take an admin away, so the
 * last-admin rule applies to them; reactivate and restore can only ADD one,
 * so it never does.
 */
export type AccountAction = 'suspend' | 'delete' | 'reactivate' | 'restore';

export function accountActionRefusal(input: {
  actor: HierarchyActor;
  target: HierarchyTarget;
  action: AccountAction;
  activeAdmins?: ActiveAdmins;
}): RoleRuleRefusal | null {
  const refusal = accountRefusal(input.actor, input.target);
  if (refusal !== null) return refusal;
  const removes = input.action === 'suspend' || input.action === 'delete';
  if (removes && isLastActiveAdmin(input.target, input.activeAdmins)) return 'LAST_ADMIN';
  return null;
}

/**
 * Why an invitation is refused — at issue time against the account (if any)
 * that already holds the email, and again at acceptance against the account
 * accepting it and the inviter's CURRENT role.
 *
 * - `ROLE_NOT_INVITABLE` — not a staff role, or not below the inviter's.
 * - `ALREADY_HAS_ROLE` — that account already holds exactly this role. At
 *   acceptance this is not an error: the invitation is simply used up.
 * - `WOULD_DEMOTE` — that account already holds a HIGHER role. An invitation
 *   only ever promotes (or moves front desk ↔ coach); taking a role away is a
 *   role change, made on purpose, with a reason.
 */
export type InviteRefusal = 'ROLE_NOT_INVITABLE' | 'ALREADY_HAS_ROLE' | 'WOULD_DEMOTE';

export function inviteRefusal(input: {
  inviter: RoleName;
  role: RoleName;
  existing?: RoleName | null;
}): InviteRefusal | null {
  if (!isInvitableRole(input.role) || !canAssignRole(input.inviter, input.role)) {
    return 'ROLE_NOT_INVITABLE';
  }
  if (input.existing === undefined || input.existing === null) return null;
  if (input.existing === input.role) return 'ALREADY_HAS_ROLE';
  if (ROLE_RANK[input.existing] > ROLE_RANK[input.role]) return 'WOULD_DEMOTE';
  return null;
}

/** "Front desk", "Coach", "Super Admin" — the one set of words for a role. */
export function roleLabel(role: string): string {
  switch (role) {
    case 'CLIENT':
      return 'Member';
    case 'FRONT_DESK':
      return 'Front desk';
    case 'COACH':
      return 'Coach';
    case 'ADMIN':
      return 'Admin';
    case 'DEV':
      return 'Super Admin';
    default:
      return role;
  }
}
