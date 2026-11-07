import type { Role } from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import { DomainException } from '../common/exceptions/domain.exception';
import type { PrismaService } from '../prisma/prisma.service';
import { ROLE_PERMISSIONS } from './permission-registry';
import type { PermissionGrant } from './permission-registry';
import type { PermissionsService } from './permissions.service';
import { RoleAccessService } from './role-access.service';

type Row = { role: Role; key: string; scope: 'OWN' | 'ALL' };
type OverrideRow = { role: Role; permissionId: string; scope: 'OWN' | 'ALL' | null };

const actor = (role: Role): AuthUser =>
  ({ id: '11111111-1111-4111-8111-111111111111', role, permissionVersion: 1 }) as AuthUser;

/**
 * An in-memory RolePermission / RolePermissionOverride pair, enough for the
 * service's queries. Permission ids are `id:<key>`.
 */
function fakeDb() {
  let grants: Row[] = (['CLIENT', 'FRONT_DESK', 'COACH', 'ADMIN'] as const).flatMap((role) =>
    ROLE_PERMISSIONS[role].map((g) => ({ role, key: g.key, scope: g.scope })),
  );
  let overrides: OverrideRow[] = [];
  const keyOf = (id: string): string => id.replace(/^id:/, '');
  const bumped: Role[][] = [];
  const writes = jest.fn();

  const client = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    rolePermission: {
      findMany: jest.fn(({ where }: { where: { role: Role | { in: Role[] } } }) => {
        const roles = typeof where.role === 'string' ? [where.role] : where.role.in;
        return Promise.resolve(
          grants
            .filter((row) => roles.includes(row.role))
            .map((row) => ({ role: row.role, scope: row.scope, permission: { key: row.key } })),
        );
      }),
      deleteMany: jest.fn(
        ({ where }: { where: { role: Role; permissionId: { in: string[] } } }) => {
          writes('rolePermission.deleteMany');
          const keys = where.permissionId.in.map(keyOf);
          grants = grants.filter((row) => !(row.role === where.role && keys.includes(row.key)));
          return Promise.resolve({ count: keys.length });
        },
      ),
      createMany: jest.fn(
        ({ data }: { data: Array<{ role: Role; permissionId: string; scope: 'OWN' | 'ALL' }> }) => {
          writes('rolePermission.createMany');
          grants.push(
            ...data.map((d) => ({ role: d.role, key: keyOf(d.permissionId), scope: d.scope })),
          );
          return Promise.resolve({ count: data.length });
        },
      ),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { role_permissionId: { role: Role; permissionId: string } };
          data: { scope: 'OWN' | 'ALL' };
        }) => {
          writes('rolePermission.update');
          const { role, permissionId } = where.role_permissionId;
          const row = grants.find((r) => r.role === role && r.key === keyOf(permissionId));
          if (row) row.scope = data.scope;
          return Promise.resolve(row);
        },
      ),
    },
    rolePermissionOverride: {
      deleteMany: jest.fn(({ where }: { where: { role: Role } }) => {
        writes('override.deleteMany');
        overrides = overrides.filter((row) => row.role !== where.role);
        return Promise.resolve({ count: 0 });
      }),
      createMany: jest.fn(({ data }: { data: OverrideRow[] }) => {
        writes('override.createMany');
        overrides.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
    permission: {
      findMany: jest.fn(({ where }: { where: { key: { in: string[] } } }) =>
        Promise.resolve(where.key.in.map((key) => ({ id: `id:${key}`, key }))),
      ),
    },
    user: {
      updateMany: jest.fn(({ where }: { where: { role: { in: Role[] } } }) => {
        bumped.push(where.role.in);
        return Promise.resolve({ count: 3 });
      }),
    },
    auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const prisma = {
    ...client,
    $transaction: jest.fn((fn: (tx: typeof client) => Promise<unknown>) => fn(client)),
  };
  return {
    prisma: prisma as unknown as PrismaService,
    grantsOf: (role: Role): PermissionGrant[] =>
      grants
        .filter((row) => row.role === role)
        .map((row) => ({ key: row.key, scope: row.scope }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    overrides: () => overrides,
    bumped,
    writes,
  };
}

describe('RoleAccessService', () => {
  const record = jest.fn();
  const audit = { record } as unknown as AuditService;
  const heldBy = (role: Role): PermissionsService =>
    ({
      getEffectivePermissions: jest
        .fn()
        .mockResolvedValue(role === 'DEV' ? [] : ROLE_PERMISSIONS[role]),
    }) as unknown as PermissionsService;

  const withVoid = [...ROLE_PERMISSIONS.FRONT_DESK, { key: 'payment.void', scope: 'ALL' as const }];

  beforeEach(() => record.mockReset().mockResolvedValue(undefined));

  describe('view()', () => {
    it('unlocks Front desk and Coach for an Admin, and draws every role', async () => {
      const db = fakeDb();
      const view = await new RoleAccessService(db.prisma, heldBy('ADMIN'), audit).view(
        actor('ADMIN'),
      );

      expect(view.roles.map((r) => [r.role, r.editable])).toEqual([
        ['FRONT_DESK', true],
        ['COACH', true],
        ['ADMIN', false],
        ['CLIENT', false],
      ]);
      expect(view.roles[0].grants).toEqual(db.grantsOf('FRONT_DESK'));
      expect(view.roles[0].defaults.length).toBe(ROLE_PERMISSIONS.FRONT_DESK.length);
      expect(view.scopableKeys).toContain('checkin.self');
      expect(view.scopableKeys).not.toContain('payment.void');
    });

    it('unlocks nothing for a caller without role.permissions.update', async () => {
      const db = fakeDb();
      const permissions = {
        getEffectivePermissions: jest
          .fn()
          .mockResolvedValue([{ key: 'permission.read', scope: 'ALL' }]),
      } as unknown as PermissionsService;
      const view = await new RoleAccessService(db.prisma, permissions, audit).view(actor('ADMIN'));

      expect(view.roles.every((r) => !r.editable)).toBe(true);
    });
  });

  describe('save()', () => {
    it('writes the difference, the live grant and the cache bump, then audits it', async () => {
      const db = fakeDb();
      const service = new RoleAccessService(db.prisma, heldBy('ADMIN'), audit);

      await service.save(actor('ADMIN'), 'FRONT_DESK', {
        grants: withVoid,
        reason: 'Desk handles refunds on Sundays',
        confirm: true,
      });

      expect(db.grantsOf('FRONT_DESK').map((g) => g.key)).toContain('payment.void');
      expect(db.overrides()).toEqual([
        expect.objectContaining({
          role: 'FRONT_DESK',
          permissionId: 'id:payment.void',
          scope: 'ALL',
        }),
      ]);
      expect(db.bumped).toEqual([['FRONT_DESK']]);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ROLE_PERMISSIONS_UPDATED',
          subjectType: 'Role',
          subjectLabel: 'Front desk',
          reason: 'Desk handles refunds on Sundays',
          details: {
            role: 'FRONT_DESK',
            reset: false,
            added: [{ key: 'payment.void', scope: 'ALL' }],
            removed: [],
            changed: [],
          },
        }),
      );
    });

    it('refuses a dangerous grant without confirm, and writes nothing', async () => {
      const db = fakeDb();
      const service = new RoleAccessService(db.prisma, heldBy('ADMIN'), audit);

      await expect(
        service.save(actor('ADMIN'), 'FRONT_DESK', { grants: withVoid, reason: 'Refunds' }),
      ).rejects.toMatchObject({ code: 'ROLE_ACCESS_CONFIRM_REQUIRED' });
      expect(db.writes).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it.each<[Role, Role]>([
      ['ADMIN', 'ADMIN'],
      ['ADMIN', 'CLIENT'],
      ['DEV', 'DEV'],
      ['FRONT_DESK', 'COACH'],
    ])('refuses %s editing %s with 403 ROLE_ACCESS_NOT_EDITABLE', async (caller, role) => {
      const db = fakeDb();
      const service = new RoleAccessService(db.prisma, heldBy(caller), audit);

      const attempt = service.save(actor(caller), role, { grants: [], reason: 'Testing' });
      await expect(attempt).rejects.toBeInstanceOf(DomainException);
      await expect(attempt).rejects.toMatchObject({ code: 'ROLE_ACCESS_NOT_EDITABLE' });
      expect(db.writes).not.toHaveBeenCalled();
    });

    it('writes and audits nothing when the set is unchanged', async () => {
      const db = fakeDb();
      const service = new RoleAccessService(db.prisma, heldBy('ADMIN'), audit);

      await service.save(actor('ADMIN'), 'COACH', {
        grants: [...ROLE_PERMISSIONS.COACH],
        reason: 'No change',
      });

      expect(db.writes).not.toHaveBeenCalled();
      expect(db.bumped).toEqual([]);
      expect(record).not.toHaveBeenCalled();
    });
  });

  describe('reset()', () => {
    it('puts the defaults back and clears the stored differences', async () => {
      const db = fakeDb();
      const service = new RoleAccessService(db.prisma, heldBy('ADMIN'), audit);
      await service.save(actor('ADMIN'), 'FRONT_DESK', {
        grants: withVoid,
        reason: 'Refunds',
        confirm: true,
      });
      record.mockClear();

      await service.reset(actor('ADMIN'), 'FRONT_DESK', 'Back to normal');

      expect(db.grantsOf('FRONT_DESK').map((g) => g.key)).not.toContain('payment.void');
      expect(db.overrides()).toEqual([]);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'Back to normal',
          details: expect.objectContaining({ reset: true, removed: ['payment.void'] }),
        }),
      );
    });
  });
});
