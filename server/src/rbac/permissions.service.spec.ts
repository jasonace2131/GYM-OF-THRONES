import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSION_CACHE_MAX_ENTRIES, PermissionsService } from './permissions.service';

const CLIENT_USER = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  role: 'CLIENT' as const,
  permissionVersion: 0,
};
const DEV_USER = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  role: 'DEV' as const,
  permissionVersion: 0,
};

describe('PermissionsService', () => {
  let service: PermissionsService;
  let findManyRolePermission: jest.Mock;
  let findManyPermission: jest.Mock;

  beforeEach(async () => {
    findManyRolePermission = jest.fn().mockResolvedValue([
      { scope: 'OWN', permission: { key: 'checkin.self' } },
      { scope: 'ALL', permission: { key: 'announcement.read' } },
    ]);
    findManyPermission = jest
      .fn()
      .mockResolvedValue([{ key: 'member.read' }, { key: 'role.change' }]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        PermissionsService,
        {
          provide: PrismaService,
          useValue: {
            rolePermission: { findMany: findManyRolePermission },
            permission: { findMany: findManyPermission },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(PermissionsService);
  });

  it("resolves a role user's permissions from RolePermission", async () => {
    await expect(service.getEffectivePermissions(CLIENT_USER)).resolves.toEqual([
      { key: 'checkin.self', scope: 'OWN' },
      { key: 'announcement.read', scope: 'ALL' },
    ]);
    expect(findManyRolePermission).toHaveBeenCalledWith({
      where: { role: 'CLIENT' },
      select: { scope: true, permission: { select: { key: true } } },
    });
  });

  it('gives DEV every catalogue permission at scope ALL, bypassing RolePermission', async () => {
    await expect(service.getEffectivePermissions(DEV_USER)).resolves.toEqual([
      { key: 'member.read', scope: 'ALL' },
      { key: 'role.change', scope: 'ALL' },
    ]);
    expect(findManyRolePermission).not.toHaveBeenCalled();
  });

  it('caches by userId + permissionVersion, skipping the second DB call', async () => {
    await service.getEffectivePermissions(CLIENT_USER);
    await service.getEffectivePermissions(CLIENT_USER);
    expect(findManyRolePermission).toHaveBeenCalledTimes(1);
  });

  it('re-queries when permissionVersion changes', async () => {
    await service.getEffectivePermissions(CLIENT_USER);
    await service.getEffectivePermissions({ ...CLIENT_USER, permissionVersion: 1 });
    expect(findManyRolePermission).toHaveBeenCalledTimes(2);
  });

  // The demotion window: an ADMIN demoted to CLIENT keeps the same id and the
  // same permissionVersion until the bump lands, so a key without `role` in it
  // serves the old set for the rest of the TTL.
  it('re-resolves when the role changes at the same id and version', async () => {
    await service.getEffectivePermissions({ ...CLIENT_USER, role: 'COACH' });
    await service.getEffectivePermissions({ ...CLIENT_USER, role: 'ADMIN' });

    expect(findManyRolePermission).toHaveBeenCalledTimes(2);
    expect(findManyRolePermission).toHaveBeenNthCalledWith(1, {
      where: { role: 'COACH' },
      select: { scope: true, permission: { select: { key: true } } },
    });
    expect(findManyRolePermission).toHaveBeenNthCalledWith(2, {
      where: { role: 'ADMIN' },
      select: { scope: true, permission: { select: { key: true } } },
    });
  });

  it('evicts the coldest entry once the cache is full', async () => {
    for (let i = 0; i < PERMISSION_CACHE_MAX_ENTRIES; i += 1) {
      await service.getEffectivePermissions({ ...CLIENT_USER, id: `user-${i}` });
    }
    expect(findManyRolePermission).toHaveBeenCalledTimes(PERMISSION_CACHE_MAX_ENTRIES);

    // Still hot — the cache is exactly full, nothing has been dropped yet.
    await service.getEffectivePermissions({ ...CLIENT_USER, id: 'user-0' });
    expect(findManyRolePermission).toHaveBeenCalledTimes(PERMISSION_CACHE_MAX_ENTRIES);

    // One more entry must evict something, and `user-0` was just touched, so
    // the victim is `user-1` rather than `user-0`.
    await service.getEffectivePermissions({ ...CLIENT_USER, id: 'overflow' });
    await service.getEffectivePermissions({ ...CLIENT_USER, id: 'user-0' });
    expect(findManyRolePermission).toHaveBeenCalledTimes(PERMISSION_CACHE_MAX_ENTRIES + 1);

    await service.getEffectivePermissions({ ...CLIENT_USER, id: 'user-1' });
    expect(findManyRolePermission).toHaveBeenCalledTimes(PERMISSION_CACHE_MAX_ENTRIES + 2);
  });

  describe('resolveScope', () => {
    it('returns the scope the role holds', async () => {
      await expect(service.resolveScope(CLIENT_USER, 'checkin.self')).resolves.toBe('OWN');
      await expect(service.resolveScope(CLIENT_USER, 'announcement.read')).resolves.toBe('ALL');
    });

    it('returns ALL when any held grant is ALL', async () => {
      findManyRolePermission.mockResolvedValue([
        { scope: 'OWN', permission: { key: 'coach.read' } },
        { scope: 'ALL', permission: { key: 'coach.read' } },
      ]);
      await expect(service.resolveScope(CLIENT_USER, 'coach.read')).resolves.toBe('ALL');
    });

    it('throws a wiring-bug error for a key the route never declared', async () => {
      await expect(service.resolveScope(CLIENT_USER, 'member.delete')).rejects.toThrow(
        "scopeFilter('member.delete') on a route that does not require it",
      );
    });
  });

  describe('scopeFilter', () => {
    it('yields {} for ALL on subjects with no deletedAt column', async () => {
      await expect(
        service.scopeFilter(CLIENT_USER, 'announcement.read', 'ownedByUser'),
      ).resolves.toEqual({});
      await expect(
        service.scopeFilter(CLIENT_USER, 'announcement.read', 'coachAssignment'),
      ).resolves.toEqual({});
    });

    it('yields only the soft-delete filter for ALL on a user subject — §4.4 applies at every scope', async () => {
      await expect(service.scopeFilter(CLIENT_USER, 'announcement.read', 'user')).resolves.toEqual({
        deletedAt: null,
      });
    });

    it('yields the id-or-assignment OR, ANDed with the soft-delete filter, for OWN on a user subject', async () => {
      await expect(service.scopeFilter(CLIENT_USER, 'checkin.self', 'user')).resolves.toEqual({
        OR: [
          { id: CLIENT_USER.id },
          { assignedCoach: { some: { coachId: CLIENT_USER.id, endedAt: null } } },
        ],
        deletedAt: null,
      });
    });

    it('yields the one-hop OR for OWN on a userId-owned subject', async () => {
      await expect(
        service.scopeFilter(CLIENT_USER, 'checkin.self', 'ownedByUser'),
      ).resolves.toEqual({
        OR: [
          { userId: CLIENT_USER.id },
          { user: { assignedCoach: { some: { coachId: CLIENT_USER.id, endedAt: null } } } },
        ],
      });
    });

    it('yields the coachId-or-memberId OR for OWN on a coachAssignment subject', async () => {
      await expect(
        service.scopeFilter(CLIENT_USER, 'checkin.self', 'coachAssignment'),
      ).resolves.toEqual({
        OR: [{ coachId: CLIENT_USER.id }, { memberId: CLIENT_USER.id }],
      });
    });

    it('yields an active-assignment filter with NO self branch for OWN on a coachedMember subject', async () => {
      await expect(
        service.scopeFilter(CLIENT_USER, 'checkin.self', 'coachedMember'),
      ).resolves.toEqual({
        assignedCoach: { some: { coachId: CLIENT_USER.id, endedAt: null } },
        deletedAt: null,
      });
    });

    it('yields only the soft-delete filter for ALL on a coachedMember subject', async () => {
      await expect(
        service.scopeFilter(CLIENT_USER, 'announcement.read', 'coachedMember'),
      ).resolves.toEqual({ deletedAt: null });
    });
  });
});
