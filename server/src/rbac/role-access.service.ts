import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import {
  PERMISSIONS,
  canEditRoleAccess,
  editableAccessRoles,
  roleLabel,
  type DomainErrorCode,
} from '@got/shared';
import type { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSION_CATALOGUE, ROLE_PERMISSIONS } from './permission-registry';
import type { PermissionGrant } from './permission-registry';
import { bumpPermissionVersionForRoles } from './permission-version';
import { PermissionsService } from './permissions.service';
import {
  SCOPABLE_PERMISSION_KEYS,
  checkRoleAccess,
  diffGrants,
  isEmptyDiff,
  overridesFor,
  type EditableRole,
  type GrantDiff,
  type RoleAccessRefusal,
} from './role-access';

/** The tab order on Staff & Access → Edit role access. */
export const ROLE_ACCESS_ORDER: readonly EditableRole[] = [
  'FRONT_DESK',
  'COACH',
  'ADMIN',
  'CLIENT',
];

/** One role as the editor draws it. Mirrored in client/src/lib/staff/accessEditor.ts. */
export interface RoleAccessRoleView {
  role: EditableRole;
  /** Whether THIS caller may change it (`role.permissions.update` + the role rules). */
  editable: boolean;
  /** What the role holds now. */
  grants: PermissionGrant[];
  /** What the code gives it out of the box; "Reset to defaults" goes back here. */
  defaults: PermissionGrant[];
  /** The last save or reset, from Audit Logs. */
  lastChange: { at: string; byName: string } | null;
}

export interface RoleAccessView {
  roles: RoleAccessRoleView[];
  /** Keys that take Own or All. Every other key is simply on or off (stored at ALL). */
  scopableKeys: string[];
}

export interface SaveRoleAccessInput {
  grants: PermissionGrant[];
  reason: string;
  confirm?: boolean;
}

const sortGrants = (grants: PermissionGrant[]): PermissionGrant[] =>
  [...grants].sort((a, b) => a.key.localeCompare(b.key));

/**
 * Edit role access (feat/role-access-editor, owner 2026-11-07).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE TRANSACTION PER SAVE, AND THE CACHE BUMP INSIDE IT.
 *
 * A save writes three things that must agree: the gym's differences
 * (`RolePermissionOverride`, what the next deploy's seed reads), the live
 * grants (`RolePermission`, what every request reads), and `permissionVersion`
 * for everybody holding the role, so the change applies on their next request
 * rather than after the 60-second cache. A save that landed half of that
 * would either be undone by the next deploy or not apply until it.
 *
 * Two admins saving the same role at once queue on a per-role advisory lock,
 * so the second save is checked against the first one's result.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class RoleAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
  ) {}

  async view(actor: AuthUser): Promise<RoleAccessView> {
    const held = await this.permissions.getEffectivePermissions(actor);
    const mayUpdate = held.some((p) => p.key === PERMISSIONS.ROLE_PERMISSIONS_UPDATE);

    const [rows, changes] = await Promise.all([
      this.prisma.rolePermission.findMany({
        where: { role: { in: [...ROLE_ACCESS_ORDER] } },
        select: { role: true, scope: true, permission: { select: { key: true } } },
      }),
      Promise.all(ROLE_ACCESS_ORDER.map((role) => this.lastChange(role))),
    ]);

    return {
      roles: ROLE_ACCESS_ORDER.map((role, index) => ({
        role,
        editable: mayUpdate && canEditRoleAccess(actor.role, role),
        grants: sortGrants(
          rows
            .filter((row) => row.role === role)
            .map((row) => ({ key: row.permission.key, scope: row.scope })),
        ),
        defaults: sortGrants([...ROLE_PERMISSIONS[role]]),
        lastChange: changes[index],
      })),
      scopableKeys: [...SCOPABLE_PERMISSION_KEYS].sort(),
    };
  }

  /** Replace what `role` can do with `input.grants`. A no-op save writes nothing. */
  async save(
    actor: AuthUser,
    role: Role,
    input: SaveRoleAccessInput,
    options: { reset?: boolean } = {},
  ): Promise<RoleAccessView> {
    const editable = this.assertEditable(actor, role);
    const actorHeld = [...(await this.permissions.getEffectivePermissions(actor))];

    const diff = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`role-access:${editable}`}))`;

      const before = await this.liveGrants(tx, editable);
      const refusal = checkRoleAccess({
        role: editable,
        before,
        defaults: ROLE_PERMISSIONS[editable],
        desired: input.grants,
        catalogue: PERMISSION_CATALOGUE,
        actorHeld,
        confirm: input.confirm === true,
      });
      if (refusal !== null) throw refusalException(refusal);

      const change = diffGrants(before, input.grants);
      if (isEmptyDiff(change)) return change;

      await this.write(tx, editable, actor.id, change, input.grants);
      return change;
    });

    if (!isEmptyDiff(diff)) {
      await this.audit.record({
        action: 'ROLE_PERMISSIONS_UPDATED',
        actorId: actor.id,
        actorRole: actor.role,
        subjectType: 'Role',
        subjectLabel: roleLabel(editable),
        reason: input.reason,
        details: {
          role: editable,
          reset: options.reset === true,
          added: diff.added.map((g) => ({ key: g.key, scope: g.scope })),
          removed: diff.removed,
          changed: diff.changed.map((c) => ({ key: c.key, from: c.from, to: c.to })),
        },
      });
    }
    return this.view(actor);
  }

  /**
   * Back to the code's defaults. Goes through `save`, so it meets every rule a
   * save does; the reset dialog is itself the confirmation for any dangerous
   * default it brings back.
   */
  async reset(actor: AuthUser, role: Role, reason: string): Promise<RoleAccessView> {
    const editable = this.assertEditable(actor, role);
    return this.save(
      actor,
      editable,
      { grants: [...ROLE_PERMISSIONS[editable]], reason, confirm: true },
      { reset: true },
    );
  }

  private assertEditable(actor: AuthUser, role: Role): EditableRole {
    if (role === 'DEV') {
      throw new DomainException(
        'ROLE_ACCESS_NOT_EDITABLE',
        'The Super Admin always has every permission and cannot be edited.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!canEditRoleAccess(actor.role, role)) {
      throw new DomainException(
        'ROLE_ACCESS_NOT_EDITABLE',
        editableAccessRoles(actor.role).length === 0
          ? 'Only an Admin or the Super Admin can change what a role can do.'
          : `Only the Super Admin can change what ${roleLabel(role)} accounts can do.`,
        HttpStatus.FORBIDDEN,
      );
    }
    return role;
  }

  private async liveGrants(
    tx: Prisma.TransactionClient,
    role: EditableRole,
  ): Promise<PermissionGrant[]> {
    const rows = await tx.rolePermission.findMany({
      where: { role },
      select: { scope: true, permission: { select: { key: true } } },
    });
    return rows.map((row) => ({ key: row.permission.key, scope: row.scope }));
  }

  private async write(
    tx: Prisma.TransactionClient,
    role: EditableRole,
    actorId: string,
    diff: GrantDiff,
    desired: PermissionGrant[],
  ): Promise<void> {
    const overrides = overridesFor(ROLE_PERMISSIONS[role], desired);
    const keys = new Set([
      ...overrides.map((o) => o.key),
      ...diff.added.map((g) => g.key),
      ...diff.removed,
      ...diff.changed.map((c) => c.key),
    ]);
    const permissions = await tx.permission.findMany({
      where: { key: { in: [...keys] } },
      select: { id: true, key: true },
    });
    const idOf = new Map(permissions.map((p) => [p.key, p.id]));
    const id = (key: string): string => {
      const found = idOf.get(key);
      // The catalogue check already passed, so a missing row means the seed
      // has not run since the key was added. Refuse rather than half-write.
      if (found === undefined) throw new Error(`Permission row missing for "${key}"`);
      return found;
    };

    // The differences, replaced whole: what the next deploy's seed reads.
    await tx.rolePermissionOverride.deleteMany({ where: { role } });
    if (overrides.length > 0) {
      await tx.rolePermissionOverride.createMany({
        data: overrides.map((o) => ({
          role,
          permissionId: id(o.key),
          scope: o.scope,
          updatedById: actorId,
        })),
      });
    }

    // The live grants: what every request reads.
    if (diff.removed.length > 0) {
      await tx.rolePermission.deleteMany({
        where: { role, permissionId: { in: diff.removed.map(id) } },
      });
    }
    if (diff.added.length > 0) {
      await tx.rolePermission.createMany({
        data: diff.added.map((g) => ({ role, permissionId: id(g.key), scope: g.scope })),
      });
    }
    for (const change of diff.changed) {
      await tx.rolePermission.update({
        where: { role_permissionId: { role, permissionId: id(change.key) } },
        data: { scope: change.to },
      });
    }

    await bumpPermissionVersionForRoles(tx, [role]);
  }

  private async lastChange(role: EditableRole): Promise<RoleAccessRoleView['lastChange']> {
    const entry = await this.prisma.auditLog.findFirst({
      where: { action: 'ROLE_PERMISSIONS_UPDATED', details: { path: ['role'], equals: role } },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true, actor: { select: { firstName: true, lastName: true } } },
    });
    if (entry === null) return null;
    const name = `${entry.actor.firstName} ${entry.actor.lastName}`.trim();
    return { at: entry.occurredAt.toISOString(), byName: name === '' ? 'Staff' : name };
  }
}

const describeKeys = (keys: string[]): string => {
  const byKey = new Map(PERMISSION_CATALOGUE.map((def) => [def.key, def.description]));
  return keys.map((key) => byKey.get(key) ?? key).join(', ');
};

/** The refusal, in the words the editor shows. */
export function refusalException(refusal: RoleAccessRefusal): DomainException {
  const table: Record<
    RoleAccessRefusal['code'],
    { code: DomainErrorCode; status: HttpStatus; message: string }
  > = {
    UNKNOWN_PERMISSION: {
      code: 'ROLE_ACCESS_UNKNOWN_PERMISSION',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      message: `These permissions do not exist: ${refusal.keys.join(', ')}.`,
    },
    SCOPE_NOT_SUPPORTED: {
      code: 'ROLE_ACCESS_SCOPE_NOT_SUPPORTED',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      message: `"Own" is not available for: ${describeKeys(refusal.keys)}. Turn them on for everyone instead.`,
    },
    PREREQUISITE_MISSING: {
      code: 'ROLE_ACCESS_PREREQUISITE_MISSING',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      message: `These need another permission turned on first: ${describeKeys(refusal.keys)}.`,
    },
    LOCKED: {
      code: 'ROLE_ACCESS_LOCKED',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      message: `Admins always keep these, so nobody is locked out of Staff & Access: ${describeKeys(refusal.keys)}.`,
    },
    ESCALATION: {
      code: 'ROLE_ACCESS_ESCALATION',
      status: HttpStatus.FORBIDDEN,
      message: `You can only give permissions you hold yourself: ${describeKeys(refusal.keys)}.`,
    },
    CONFIRM_REQUIRED: {
      code: 'ROLE_ACCESS_CONFIRM_REQUIRED',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      message: `Confirm the dangerous permissions before saving: ${describeKeys(refusal.keys)}.`,
    },
  };
  const entry = table[refusal.code];
  return new DomainException(entry.code, entry.message, entry.status);
}
