import { AdminPermissionsController, groupByResource } from './admin-permissions.controller';
import { REQUIRE_PERMISSION_KEY } from './decorators/require-permission.decorator';
import { PERMISSION_CATALOGUE } from './permission-registry';
import type { PrismaService } from '../prisma/prisma.service';

describe('groupByResource', () => {
  it('groups catalogue entries by resource', () => {
    const grouped = groupByResource([
      {
        key: 'member.read',
        resource: 'member',
        action: 'read',
        description: 'x',
        isDangerous: false,
        requires: [],
      },
      {
        key: 'member.create',
        resource: 'member',
        action: 'create',
        description: 'y',
        isDangerous: false,
        requires: [],
      },
      {
        key: 'coach.read',
        resource: 'coach',
        action: 'read',
        description: 'z',
        isDangerous: false,
        requires: [],
      },
    ]);

    expect(Object.keys(grouped).sort()).toEqual(['coach', 'member']);
    expect(grouped['member']).toHaveLength(2);
    expect(grouped['coach']).toHaveLength(1);
  });
});

describe('AdminPermissionsController', () => {
  it('returns the full catalogue grouped by resource', () => {
    const controller = new AdminPermissionsController({} as unknown as PrismaService);
    const result = controller.list();
    const flatCount = Object.values(result).reduce((sum, entries) => sum + entries.length, 0);
    expect(flatCount).toBe(PERMISSION_CATALOGUE.length);
  });

  // The handler takes no @CurrentUser and reads nothing per-caller, so a
  // dropped decorator would not fail any behavioural test — assert the
  // metadata directly.
  it('is gated on permission.read', () => {
    // Reading metadata off the function object, never calling it — `this` is
    // irrelevant here, so unbound-method does not apply.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const handler = AdminPermissionsController.prototype.list;
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe('permission.read');
  });

  // ── Staff & Access: "What each role can do" ──────────────────────────────
  describe('roles()', () => {
    const findMany = jest.fn();
    const controller = new AdminPermissionsController({
      rolePermission: { findMany },
    } as unknown as PrismaService);

    beforeEach(() => findMany.mockReset());

    it('groups the SEEDED grants by role, key-sorted, with their scope', async () => {
      findMany.mockResolvedValue([
        { role: 'COACH', scope: 'OWN', permission: { key: 'member.read' } },
        { role: 'ADMIN', scope: 'ALL', permission: { key: 'staff.invite' } },
        { role: 'ADMIN', scope: 'ALL', permission: { key: 'member.read' } },
        { role: 'CLIENT', scope: 'OWN', permission: { key: 'checkin.self' } },
      ]);

      await expect(controller.roles()).resolves.toEqual({
        CLIENT: [{ key: 'checkin.self', scope: 'OWN' }],
        FRONT_DESK: [],
        COACH: [{ key: 'member.read', scope: 'OWN' }],
        ADMIN: [
          { key: 'member.read', scope: 'ALL' },
          { key: 'staff.invite', scope: 'ALL' },
        ],
      });
    });

    // DEV holds no rows — it bypasses the table. The console draws its column
    // as "everything at ALL" rather than pretending a grant exists.
    it('never reports a DEV column, even if a stray row existed', async () => {
      findMany.mockResolvedValue([{ role: 'DEV', scope: 'ALL', permission: { key: 'job.run' } }]);
      await expect(controller.roles()).resolves.not.toHaveProperty('DEV');
    });

    it('is gated on permission.read, like the catalogue beside it', () => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const handler = AdminPermissionsController.prototype.roles;
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe('permission.read');
    });
  });
});
