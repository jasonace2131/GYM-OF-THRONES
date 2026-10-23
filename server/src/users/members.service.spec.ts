import { HttpStatus } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { MembershipStatus } from '@got/shared';
import { MembersService } from './members.service';
import type { AuditService } from '../audit/audit.service';
import { ASSIGNABLE_ROLES } from './dto/change-role.dto';
import { DomainException } from '../common/exceptions/domain.exception';
import type { ScopedWhere } from '../rbac/scope.util';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import type { ListMembersQueryDto } from './dto/list-members-query.dto';
import type { MemberCountsQueryDto } from './dto/member-counts-query.dto';
import type { CreateMemberDto } from './dto/create-member.dto';
import type { SupabaseAdminService } from '../auth/supabase-admin.service';
import type { MemberJoinService } from './member-join.service';
import type { PermissionsService } from '../rbac/permissions.service';
import type { MembershipSalesService } from '../membership/membership-sales.service';
import type { AuthUser } from '../auth/auth.types';

const MEMBER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NEW_SUPABASE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const ADMIN: AuthUser = {
  id: ADMIN_ID,
  supabaseId: '11111111-1111-1111-1111-111111111111',
  email: 'admin@example.com',
  firstName: 'Admin',
  lastName: 'User',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  permissionVersion: 0,
  heightCm: null,
  weightKg: null,
  deletedAt: null,
};

/** The Super Admin — the only account that manages ADMINs. */
const DEV_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DEV: AuthUser = { ...ADMIN, id: DEV_ID, email: 'dev@example.com', role: Role.DEV };

type UserScope = ScopedWhere<Prisma.UserWhereInput>;

const ALL_SCOPE = { deletedAt: null } as unknown as UserScope;
const OWN_SCOPE = {
  OR: [{ id: MEMBER_ID }, { assignedCoach: { some: { coachId: MEMBER_ID, endedAt: null } } }],
  deletedAt: null,
} as unknown as UserScope;

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: MEMBER_ID,
    memberCode: 'ABC123',
    firstName: 'Jon',
    lastName: 'Snow',
    email: 'jon@example.com',
    phone: null,
    avatarUrl: null,
    role: Role.CLIENT,
    status: UserStatus.ACTIVE,
    emergencyContact: null,
    suspendedAt: null,
    suspendedById: null,
    suspendReason: null,
    lastSeenAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    deletedAt: null,
    membership: null,
    _count: { checkIns: 0 },
    ...overrides,
  };
}

function query(overrides: Partial<ListMembersQueryDto> = {}): ListMembersQueryDto {
  return { page: 1, limit: 10, deleted: false, sort: 'recent', ...overrides } as ListMembersQueryDto;
}

function countsQuery(
  overrides: Partial<MemberCountsQueryDto> = {},
): MemberCountsQueryDto {
  return { deleted: false, ...overrides } as MemberCountsQueryDto;
}

interface PrismaMock {
  user: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
  };
  lead: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  memberJoinLink: {
    deleteMany: jest.Mock;
  };
  $transaction: jest.Mock;
}

function buildPrisma(): PrismaMock {
  const user = {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  };
  const lead = {
    findUnique: jest.fn(),
    update: jest.fn(),
  };
  const mock: PrismaMock = {
    user,
    lead,
    memberJoinLink: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg as Promise<unknown>[])
        : (arg as (tx: PrismaMock) => Promise<unknown>)(mock),
    ),
  };
  return mock;
}

function buildGym(): GymConfigService {
  return {
    timeZone: 'Asia/Manila',
    expiringSoonDays: 7,
    graceAdmissionsMax: 1,
  } as unknown as GymConfigService;
}

interface SupabaseAdminMock {
  createAuthUser: jest.Mock;
  updateAuthEmail: jest.Mock;
  deleteUser: jest.Mock;
}

function buildSupabaseAdmin(): SupabaseAdminMock {
  return { createAuthUser: jest.fn(), updateAuthEmail: jest.fn(), deleteUser: jest.fn() };
}

interface MemberJoinMock {
  issue: jest.Mock;
}

function buildMemberJoin(): MemberJoinMock {
  return { issue: jest.fn().mockResolvedValue(true) };
}

interface PermissionsMock {
  getEffectivePermissions: jest.Mock;
}

/** Defaults to "holds membership.sell" so tests that don't care about the
 *  gate can ignore it entirely. */
function buildPermissions(held: string[] = ['membership.sell']): PermissionsMock {
  return {
    getEffectivePermissions: jest.fn().mockResolvedValue(held.map((key) => ({ key, scope: 'ALL' }))),
  };
}

interface SalesMock {
  sell: jest.Mock;
}

function buildSales(): SalesMock {
  return { sell: jest.fn() };
}

function createDto(overrides: Partial<CreateMemberDto> = {}): CreateMemberDto {
  return {
    firstName: 'Jon',
    lastName: 'Snow',
    email: 'jon@example.com',
    ...overrides,
  } as CreateMemberDto;
}

describe('MembersService', () => {
  let prisma: PrismaMock;
  let supabaseAdmin: SupabaseAdminMock;
  let memberJoin: MemberJoinMock;
  let permissions: PermissionsMock;
  let sales: SalesMock;
  let service: MembersService;
  const NOW = new Date('2026-08-27T04:00:00.000Z');

  beforeEach(() => {
    prisma = buildPrisma();
    supabaseAdmin = buildSupabaseAdmin();
    memberJoin = buildMemberJoin();
    permissions = buildPermissions();
    sales = buildSales();
    service = new MembersService(
      prisma as unknown as PrismaService,
      buildGym(),
      supabaseAdmin as unknown as SupabaseAdminService,
      memberJoin as unknown as MemberJoinService,
      permissions as unknown as PermissionsService,
      sales as unknown as MembershipSalesService,
      // The audit trail is best-effort by contract, so these tests assert the
      // ACTION, never the log line. A no-op recorder keeps them about the
      // behaviour they were written for.
      { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
    );
  });

  describe('update', () => {
    it('404s on a scoped miss without ever calling update', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.update(MEMBER_ID, { firstName: 'Ned' }, ALL_SCOPE, NOW),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_NOT_FOUND' } });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('writes only the fields present in the dto, leaving the rest untouched', async () => {
      prisma.user.findFirst.mockResolvedValue(row());
      prisma.user.update.mockResolvedValue(row());

      await service.update(
        MEMBER_ID,
        { phone: '+639171234567' },
        ALL_SCOPE,
        NOW,
      );

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: MEMBER_ID },
        data: { phone: '+639171234567' },
      });
    });

    it('writes emergencyContact, including clearing it with an empty string', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ emergencyContact: 'Old contact' }));
      prisma.user.update.mockResolvedValue(row({ emergencyContact: '' }));

      await service.update(MEMBER_ID, { emergencyContact: '' }, ALL_SCOPE, NOW);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: MEMBER_ID },
        data: { emergencyContact: '' },
      });
    });

    it('returns the fresh state, re-read after the write', async () => {
      prisma.user.findFirst
        .mockResolvedValueOnce(row({ firstName: 'Jon' }))
        .mockResolvedValueOnce(row({ firstName: 'Aegon' }));
      prisma.user.update.mockResolvedValue(row({ firstName: 'Aegon' }));

      const result = await service.update(MEMBER_ID, { firstName: 'Aegon' }, ALL_SCOPE, NOW);

      expect(result.firstName).toBe('Aegon');
      expect(prisma.user.findFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe('suspend', () => {
    it('rejects a caller suspending themselves, before touching the database', async () => {
      await expect(
        service.suspend(ADMIN_ID, { reason: 'Mis-click' }, ADMIN, ALL_SCOPE, NOW),
      ).rejects.toMatchObject({
        response: { code: 'MEMBER_SELF_SUSPEND' },
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses to suspend a DEV account', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ role: Role.DEV }));

      await expect(
        service.suspend(MEMBER_ID, { reason: 'Locking out the dev' }, ADMIN, ALL_SCOPE, NOW),
      ).rejects.toMatchObject({
        response: { code: 'MEMBER_DEV_PROTECTED' },
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('404s a DEV target the caller cannot reach — scope miss wins over the DEV guard', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.suspend(MEMBER_ID, { reason: 'Locking out the dev' }, ADMIN, OWN_SCOPE, NOW),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_NOT_FOUND' } });
    });

    it('refuses a DEACTIVATED target — suspend→reactivate is not a route back to ACTIVE', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ status: UserStatus.DEACTIVATED }));

      await expect(
        service.suspend(MEMBER_ID, { reason: 'Laundering a dead account' }, ADMIN, ALL_SCOPE, NOW),
      ).rejects.toMatchObject({
        response: { code: 'MEMBER_NOT_ACTIVE' },
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('404s on a scoped miss without ever calling update', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.suspend(MEMBER_ID, { reason: 'Chargeback dispute' }, ADMIN, ALL_SCOPE, NOW),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_NOT_FOUND' } });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a member already suspended, before writing anything', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ status: UserStatus.SUSPENDED }));

      await expect(
        service.suspend(MEMBER_ID, { reason: 'Second attempt' }, ADMIN, ALL_SCOPE, NOW),
      ).rejects.toMatchObject({
        response: { code: 'MEMBER_ALREADY_SUSPENDED' },
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('sets status SUSPENDED plus suspendedAt/suspendedById/suspendReason together', async () => {
      const after = row({
        status: UserStatus.SUSPENDED,
        suspendedAt: NOW,
        suspendedById: ADMIN_ID,
        suspendReason: 'Chargeback dispute',
      });
      prisma.user.findFirst
        .mockResolvedValueOnce(row({ status: UserStatus.ACTIVE }))
        .mockResolvedValueOnce(after);
      prisma.user.update.mockResolvedValue(after);

      const result = await service.suspend(
        MEMBER_ID,
        { reason: 'Chargeback dispute' },
        ADMIN,
        ALL_SCOPE,
        NOW,
      );

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: MEMBER_ID },
        data: {
          status: UserStatus.SUSPENDED,
          suspendedAt: NOW,
          suspendedById: ADMIN_ID,
          suspendReason: 'Chargeback dispute',
        },
      });
      expect(result.status).toBe(UserStatus.SUSPENDED);
    });
  });

  describe('reactivate', () => {
    it('rejects a caller reactivating themselves, before touching the database', async () => {
      await expect(service.reactivate(ADMIN_ID, ADMIN, ALL_SCOPE, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_SELF_REACTIVATE' },
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('404s on a scoped miss without ever calling update', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.reactivate(MEMBER_ID, ADMIN, ALL_SCOPE, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_NOT_FOUND' },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a member who is not suspended, before writing anything', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ status: UserStatus.ACTIVE }));

      await expect(service.reactivate(MEMBER_ID, ADMIN, ALL_SCOPE, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_NOT_SUSPENDED' },
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('clears status back to ACTIVE and nulls all three suspension fields', async () => {
      const after = row({ status: UserStatus.ACTIVE });
      prisma.user.findFirst
        .mockResolvedValueOnce(
          row({
            status: UserStatus.SUSPENDED,
            suspendedAt: new Date('2026-08-20T00:00:00.000Z'),
            suspendedById: ADMIN_ID,
            suspendReason: 'Chargeback dispute',
          }),
        )
        .mockResolvedValueOnce(after);
      prisma.user.update.mockResolvedValue(after);

      const result = await service.reactivate(MEMBER_ID, ADMIN, ALL_SCOPE, NOW);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: MEMBER_ID },
        data: {
          status: UserStatus.ACTIVE,
          suspendedAt: null,
          suspendedById: null,
          suspendReason: null,
        },
      });
      expect(result.status).toBe(UserStatus.ACTIVE);
    });
  });

  describe('remove (soft delete)', () => {
    it('rejects a caller deleting their own account, before touching the database', async () => {
      await expect(service.remove(ADMIN_ID, ADMIN, ALL_SCOPE, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_SELF_DELETE' },
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses to delete a DEV account', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ role: Role.DEV }));

      await expect(service.remove(MEMBER_ID, ADMIN, ALL_SCOPE, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_DEV_PROTECTED' },
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('404s on a scoped miss without ever calling update', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.remove(MEMBER_ID, ADMIN, ALL_SCOPE, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_NOT_FOUND' },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('sets deletedAt and returns the pre-delete snapshot rather than 204', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ firstName: 'Jon' }));
      prisma.user.update.mockResolvedValue(row({ firstName: 'Jon', deletedAt: NOW }));

      const result = await service.remove(MEMBER_ID, ADMIN, ALL_SCOPE, NOW);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: MEMBER_ID },
        data: { deletedAt: NOW },
      });
      // The snapshot came from BEFORE the delete — only one findFirst call,
      // never a second re-read (which would 404 against its own deletedAt filter).
      expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
      expect(result.firstName).toBe('Jon');
    });

    it('404s a second delete of an already-deleted member, same as any other scoped miss', async () => {
      // findOne's own where clause filters deletedAt: null, so a second call
      // against an already-deleted row never finds it.
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.remove(MEMBER_ID, ADMIN, ALL_SCOPE, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_NOT_FOUND' },
      });
    });
  });

  describe('changeRole', () => {
    it('rejects a caller changing their own role, before touching the database', async () => {
      await expect(
        service.changeRole(ADMIN_ID, { role: Role.COACH }, ADMIN, ALL_SCOPE, NOW),
      ).rejects.toMatchObject({
        response: { code: 'ROLE_SELF_CHANGE' },
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('404s on a scoped miss without ever calling update', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.changeRole(MEMBER_ID, { role: Role.COACH }, ADMIN, ALL_SCOPE, NOW),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_NOT_FOUND' } });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('updates the role for a different member', async () => {
      const after = row({ role: Role.COACH });
      prisma.user.findFirst
        .mockResolvedValueOnce(row({ role: Role.CLIENT }))
        .mockResolvedValueOnce(after);
      prisma.user.update.mockResolvedValue(after);

      const result = await service.changeRole(
        MEMBER_ID,
        { role: Role.COACH },
        ADMIN,
        ALL_SCOPE,
        NOW,
      );

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: MEMBER_ID },
        data: { role: Role.COACH },
      });
      expect(result.role).toBe(Role.COACH);
    });

    it('refuses to change the role OF a DEV account — the DTO only blocks granting DEV, not stripping it', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ role: Role.DEV }));

      await expect(
        service.changeRole(MEMBER_ID, { role: Role.CLIENT }, ADMIN, ALL_SCOPE, NOW),
      ).rejects.toMatchObject({
        response: { code: 'MEMBER_DEV_PROTECTED' },
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('records the operator reason on the ROLE_CHANGED audit entry, with the before/after pair', async () => {
      const record = jest.fn().mockResolvedValue(undefined);
      const withActor = Object.assign(prisma, {
        user: { ...prisma.user, findUnique: jest.fn().mockResolvedValue({ role: Role.ADMIN }) },
      });
      const audited = new MembersService(
        withActor as unknown as PrismaService,
        buildGym(),
        supabaseAdmin as unknown as SupabaseAdminService,
        memberJoin as unknown as MemberJoinService,
        permissions as unknown as PermissionsService,
        sales as unknown as MembershipSalesService,
        { record } as unknown as AuditService,
      );
      prisma.user.findFirst
        .mockResolvedValueOnce(row({ role: Role.COACH }))
        .mockResolvedValueOnce(row({ role: Role.ADMIN }));
      prisma.user.update.mockResolvedValue(row({ role: Role.ADMIN }));

      // DEV, not ADMIN: only the Super Admin makes somebody an admin.
      await audited.changeRole(
        MEMBER_ID,
        { role: Role.ADMIN, reason: 'covering the owner while away' },
        DEV,
        ALL_SCOPE,
        NOW,
      );

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ROLE_CHANGED',
          reason: 'covering the owner while away',
          details: { before: Role.COACH, after: Role.ADMIN },
        }),
        NOW,
      );
    });

    it('records a null reason when none was given, rather than inventing one', async () => {
      const record = jest.fn().mockResolvedValue(undefined);
      const withActor = Object.assign(prisma, {
        user: { ...prisma.user, findUnique: jest.fn().mockResolvedValue({ role: Role.ADMIN }) },
      });
      const audited = new MembersService(
        withActor as unknown as PrismaService,
        buildGym(),
        supabaseAdmin as unknown as SupabaseAdminService,
        memberJoin as unknown as MemberJoinService,
        permissions as unknown as PermissionsService,
        sales as unknown as MembershipSalesService,
        { record } as unknown as AuditService,
      );
      prisma.user.findFirst
        .mockResolvedValueOnce(row({ role: Role.CLIENT }))
        .mockResolvedValueOnce(row({ role: Role.COACH }));
      prisma.user.update.mockResolvedValue(row({ role: Role.COACH }));

      await audited.changeRole(MEMBER_ID, { role: Role.COACH }, ADMIN, ALL_SCOPE, NOW);

      expect(record).toHaveBeenCalledWith(expect.objectContaining({ reason: null }), NOW);
    });

    it('never assigns DEV — ChangeRoleDto/ASSIGNABLE_ROLES excludes it at the DTO layer', () => {
      // The service trusts a validated ChangeRoleDto; the exclusion is
      // structural (ASSIGNABLE_ROLES has no DEV member) rather than a runtime
      // check here. Pinned via the DTO's own shape, not a service branch.
      expect(ASSIGNABLE_ROLES).not.toContain(Role.DEV);
    });
  });

  describe('restore', () => {
    it('404s when no row matches the caller reach, without writing', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.restore(MEMBER_ID, ADMIN, ALL_SCOPE, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_NOT_FOUND' },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('looks past the scope fragment deletedAt guard — a deleted row is findable here', async () => {
      prisma.user.findFirst
        .mockResolvedValueOnce({
          id: MEMBER_ID,
          deletedAt: NOW,
          role: Role.CLIENT,
          status: UserStatus.ACTIVE,
        })
        .mockResolvedValueOnce(row());
      prisma.user.update.mockResolvedValue(row());

      await service.restore(MEMBER_ID, ADMIN, OWN_SCOPE, NOW);

      const [call] = prisma.user.findFirst.mock.calls[0] as [{ where: Prisma.UserWhereInput }];
      const [, reach] = (call.where as { AND: Prisma.UserWhereInput[] }).AND;
      // OWN_SCOPE's own `deletedAt: null` is stripped; the OR reach survives.
      expect(reach).toEqual({
        OR: [{ id: MEMBER_ID }, { assignedCoach: { some: { coachId: MEMBER_ID, endedAt: null } } }],
      });
    });

    it('422s a member who was never deleted, without writing', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: MEMBER_ID,
        deletedAt: null,
        role: Role.CLIENT,
        status: UserStatus.ACTIVE,
      });

      await expect(service.restore(MEMBER_ID, ADMIN, ALL_SCOPE, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_NOT_DELETED' },
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    // Owner, 2026-10-23: an account its owner deleted is anonymised — there
    // is nobody to put back.
    it('409s an account its owner deleted, without writing', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: MEMBER_ID,
        email: `deleted+${MEMBER_ID}@deleted.invalid`,
        deletedAt: NOW,
        role: Role.CLIENT,
        status: UserStatus.ACTIVE,
      });

      await expect(service.restore(MEMBER_ID, ADMIN, ALL_SCOPE, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_SELF_DELETED' },
        status: HttpStatus.CONFLICT,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('clears deletedAt and returns the restored row, re-read through findOne', async () => {
      prisma.user.findFirst
        .mockResolvedValueOnce({
          id: MEMBER_ID,
          deletedAt: NOW,
          role: Role.CLIENT,
          status: UserStatus.ACTIVE,
        })
        .mockResolvedValueOnce(row({ firstName: 'Jon', deletedAt: null }));
      prisma.user.update.mockResolvedValue(row({ deletedAt: null }));

      const result = await service.restore(MEMBER_ID, ADMIN, ALL_SCOPE, NOW);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: MEMBER_ID },
        data: { deletedAt: null },
      });
      expect(result.firstName).toBe('Jon');
      expect(result.deletedAt).toBeNull();
    });
  });

  // ── Staff & Access: the role hierarchy on every account action ──────────
  //
  // `@got/shared`'s role-hierarchy decides; these tests pin that the service
  // ASKS it, maps each refusal to its own code, and counts active admins
  // under a row lock before taking one away.
  describe('role hierarchy', () => {
    /** Every active ADMIN row, as the locked count query returns them. */
    const lockAdmins = (count: number): jest.Mock => {
      const queryRaw = jest
        .fn()
        .mockResolvedValue(Array.from({ length: count }, (_, i) => ({ id: `admin-${i}` })));
      Object.assign(prisma, { $queryRaw: queryRaw });
      return queryRaw;
    };

    it('refuses an ADMIN promoting somebody to ADMIN — 403, nothing written', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ role: Role.COACH }));

      await expect(
        service.changeRole(MEMBER_ID, { role: Role.ADMIN }, ADMIN, ALL_SCOPE, NOW),
      ).rejects.toMatchObject({
        response: { code: 'ROLE_NOT_ASSIGNABLE' },
        status: HttpStatus.FORBIDDEN,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('lets DEV promote somebody to ADMIN', async () => {
      prisma.user.findFirst
        .mockResolvedValueOnce(row({ role: Role.COACH }))
        .mockResolvedValueOnce(row({ role: Role.ADMIN }));
      prisma.user.update.mockResolvedValue(row({ role: Role.ADMIN }));

      await service.changeRole(MEMBER_ID, { role: Role.ADMIN }, DEV, ALL_SCOPE, NOW);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: MEMBER_ID },
        data: { role: Role.ADMIN },
      });
    });

    it('refuses an ADMIN changing another ADMIN — the target outranks them', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ role: Role.ADMIN }));

      await expect(
        service.changeRole(MEMBER_ID, { role: Role.CLIENT }, ADMIN, ALL_SCOPE, NOW),
      ).rejects.toMatchObject({
        response: { code: 'ROLE_TARGET_OUTRANKS' },
        status: HttpStatus.FORBIDDEN,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses DEV demoting the LAST active ADMIN — 409, counted under a row lock', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ role: Role.ADMIN }));
      const queryRaw = lockAdmins(1);

      await expect(
        service.changeRole(MEMBER_ID, { role: Role.COACH }, DEV, ALL_SCOPE, NOW),
      ).rejects.toMatchObject({
        response: { code: 'LAST_ADMIN_PROTECTED' },
        status: HttpStatus.CONFLICT,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
      const [strings] = queryRaw.mock.calls[0] as [TemplateStringsArray];
      expect(strings.join('?')).toMatch(/FOR UPDATE/);
    });

    it('lets DEV demote an ADMIN while another active ADMIN remains, inside the lock', async () => {
      prisma.user.findFirst
        .mockResolvedValueOnce(row({ role: Role.ADMIN }))
        .mockResolvedValueOnce(row({ role: Role.COACH }));
      prisma.user.update.mockResolvedValue(row({ role: Role.COACH }));
      lockAdmins(2);

      await service.changeRole(MEMBER_ID, { role: Role.COACH }, DEV, ALL_SCOPE, NOW);

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: MEMBER_ID },
        data: { role: Role.COACH },
      });
    });

    it('does not lock or count anything when the target is not an ADMIN', async () => {
      prisma.user.findFirst
        .mockResolvedValueOnce(row({ role: Role.CLIENT }))
        .mockResolvedValueOnce(row({ role: Role.COACH }));
      prisma.user.update.mockResolvedValue(row({ role: Role.COACH }));
      const queryRaw = lockAdmins(1);

      await service.changeRole(MEMBER_ID, { role: Role.COACH }, ADMIN, ALL_SCOPE, NOW);

      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('refuses an ADMIN suspending another ADMIN', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ role: Role.ADMIN }));

      await expect(
        service.suspend(MEMBER_ID, { reason: 'Covering shifts' }, ADMIN, ALL_SCOPE, NOW),
      ).rejects.toMatchObject({ response: { code: 'ROLE_TARGET_OUTRANKS' } });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses DEV suspending the last active ADMIN', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ role: Role.ADMIN }));
      lockAdmins(1);

      await expect(
        service.suspend(MEMBER_ID, { reason: 'Stepping away' }, DEV, ALL_SCOPE, NOW),
      ).rejects.toMatchObject({ response: { code: 'LAST_ADMIN_PROTECTED' } });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses DEV deleting the last active ADMIN', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ role: Role.ADMIN }));
      lockAdmins(1);

      await expect(service.remove(MEMBER_ID, DEV, ALL_SCOPE, NOW)).rejects.toMatchObject({
        response: { code: 'LAST_ADMIN_PROTECTED' },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('lets DEV delete an ADMIN while another remains', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ role: Role.ADMIN }));
      prisma.user.update.mockResolvedValue(row({ role: Role.ADMIN, deletedAt: NOW }));
      lockAdmins(3);

      await service.remove(MEMBER_ID, DEV, ALL_SCOPE, NOW);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: MEMBER_ID },
        data: { deletedAt: NOW },
      });
    });

    it('refuses an ADMIN deleting another ADMIN', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ role: Role.ADMIN }));

      await expect(service.remove(MEMBER_ID, ADMIN, ALL_SCOPE, NOW)).rejects.toMatchObject({
        response: { code: 'ROLE_TARGET_OUTRANKS' },
      });
    });

    it('refuses an ADMIN reactivating a suspended ADMIN', async () => {
      prisma.user.findFirst.mockResolvedValue(
        row({ role: Role.ADMIN, status: UserStatus.SUSPENDED }),
      );

      await expect(service.reactivate(MEMBER_ID, ADMIN, ALL_SCOPE, NOW)).rejects.toMatchObject({
        response: { code: 'ROLE_TARGET_OUTRANKS' },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses an ADMIN restoring a deleted ADMIN', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: MEMBER_ID,
        deletedAt: NOW,
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      });

      await expect(service.restore(MEMBER_ID, ADMIN, ALL_SCOPE, NOW)).rejects.toMatchObject({
        response: { code: 'ROLE_TARGET_OUTRANKS' },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
  // ── end Staff & Access ───────────────────────────────────────────────────

  describe('list — deleted filter', () => {
    it('defaults to excluding deleted members', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.list(query(), ALL_SCOPE, NOW);

      const call = prisma.user.findMany.mock.calls[0][0] as { where: Prisma.UserWhereInput };
      expect(call.where).toEqual({ AND: [expect.objectContaining({ deletedAt: null }), ALL_SCOPE] });
    });

    it('deleted=true flips filters.deletedAt and drops the scope-side deletedAt guard', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.list(query({ deleted: true }), ALL_SCOPE, NOW);

      const call = prisma.user.findMany.mock.calls[0][0] as { where: Prisma.UserWhereInput };
      const [filters, reach] = (call.where as { AND: Prisma.UserWhereInput[] }).AND;
      expect(filters).toMatchObject({ deletedAt: { not: null } });
      // ALL_SCOPE was `{ deletedAt: null }`; with it stripped the OWN/ALL
      // reach for an ALL-scope caller is the empty object — no contradiction
      // with filters' `deletedAt: { not: null }` above.
      expect(reach).toEqual({});
    });

    it('deleted=true keeps the OWN reach (only strips deletedAt) for a scoped caller', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.list(query({ deleted: true }), OWN_SCOPE, NOW);

      const call = prisma.user.findMany.mock.calls[0][0] as { where: Prisma.UserWhereInput };
      const [, reach] = (call.where as { AND: Prisma.UserWhereInput[] }).AND;
      expect(reach).toEqual({
        OR: [{ id: MEMBER_ID }, { assignedCoach: { some: { coachId: MEMBER_ID, endedAt: null } } }],
      });
    });
  });

  describe('list — membership filters combine, never overwrite', () => {
    /** Both `findMany` and `count` must be handed the SAME where — a filter
     *  that shapes the page but not the total is a pager that lies. */
    function capturedWheres(): { findMany: Prisma.UserWhereInput; count: Prisma.UserWhereInput } {
      const findMany = (prisma.user.findMany.mock.calls[0][0] as { where: Prisma.UserWhereInput })
        .where;
      const count = (prisma.user.count.mock.calls[0][0] as { where: Prisma.UserWhereInput }).where;
      return { findMany, count };
    }

    beforeEach(() => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);
    });

    it('keeps BOTH constraints when standing and planCode arrive together', async () => {
      await service.list(query({ standing: 'ACTIVE', planCode: 'MONTHLY' }), ALL_SCOPE, NOW);

      const { findMany, count } = capturedWheres();
      const [filters] = (findMany as { AND: Prisma.UserWhereInput[] }).AND;
      const inner = (filters as { AND: Prisma.UserWhereInput[] }).AND;

      expect(inner).toContainEqual({ membership: { planCode: 'MONTHLY' } });
      // The standing clause is a date predicate on the same `membership`
      // key — before the fix the spread let whichever came last win.
      expect(inner).toContainEqual(
        expect.objectContaining({ membership: expect.objectContaining({ endsOn: expect.anything() }) }),
      );
      expect(inner).toHaveLength(2);
      expect(count).toEqual(findMany);
    });

    it('keeps all three when standing, planCode and membershipStatus arrive together', async () => {
      await service.list(
        query({ standing: 'EXPIRING', planCode: 'MONTHLY', membershipStatus: MembershipStatus.ACTIVE }),
        ALL_SCOPE,
        NOW,
      );

      const { findMany, count } = capturedWheres();
      const [filters] = (findMany as { AND: Prisma.UserWhereInput[] }).AND;
      const inner = (filters as { AND: Prisma.UserWhereInput[] }).AND;

      expect(inner).toContainEqual({ membership: { planCode: 'MONTHLY' } });
      expect(inner).toContainEqual({ membership: { status: MembershipStatus.ACTIVE } });
      expect(inner).toHaveLength(3);
      expect(count).toEqual(findMany);
    });

    it("keeps standing 'NONE' (a top-level membership: null) beside a role filter", async () => {
      await service.list(query({ standing: 'NONE', role: Role.CLIENT }), ALL_SCOPE, NOW);

      const { findMany } = capturedWheres();
      const [filters] = (findMany as { AND: Prisma.UserWhereInput[] }).AND;

      expect(filters).toMatchObject({ role: Role.CLIENT });
      expect((filters as { AND: Prisma.UserWhereInput[] }).AND).toEqual([{ membership: null }]);
    });

    it('emits no membership AND at all when no membership filter is given', async () => {
      await service.list(query(), ALL_SCOPE, NOW);

      const { findMany } = capturedWheres();
      const [filters] = (findMany as { AND: Prisma.UserWhereInput[] }).AND;

      expect(filters).not.toHaveProperty('AND');
    });

    // Staff & Access: the staff roster is everybody who is not a member.
    it('staff=true keeps every role but CLIENT', async () => {
      await service.list(query({ staff: true }), ALL_SCOPE, NOW);

      const { findMany } = capturedWheres();
      const [filters] = (findMany as { AND: Prisma.UserWhereInput[] }).AND;

      expect(filters).toMatchObject({ role: { not: Role.CLIENT } });
    });

    it('an explicit role wins over staff=true — "coaches" is a staff filter too', async () => {
      await service.list(query({ staff: true, role: Role.COACH }), ALL_SCOPE, NOW);

      const { findMany } = capturedWheres();
      const [filters] = (findMany as { AND: Prisma.UserWhereInput[] }).AND;

      expect(filters).toMatchObject({ role: Role.COACH });
    });
  });

  /**
   * The renewal call sheet. `sort=ending` is what survives the merge of the
   * Subscriptions screen into this one — that screen's whole job was
   * "who do we ring next", and its order was the answer.
   */
  describe('list — sort', () => {
    beforeEach(() => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);
    });

    function capturedOrderBy(): unknown {
      return (prisma.user.findMany.mock.calls[0][0] as { orderBy: unknown }).orderBy;
    }

    it("defaults to newest-first when `sort` is absent", async () => {
      await service.list(query({ sort: undefined }), ALL_SCOPE, NOW);

      expect(capturedOrderBy()).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
    });

    it("keeps newest-first for sort='recent'", async () => {
      await service.list(query({ sort: 'recent' }), ALL_SCOPE, NOW);

      expect(capturedOrderBy()).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
    });

    it("sort='ending' orders by the term's end date, soonest first", async () => {
      await service.list(query({ sort: 'ending' }), ALL_SCOPE, NOW);

      expect(capturedOrderBy()).toEqual([{ membership: { endsOn: 'asc' } }, { id: 'asc' }]);
    });

    /** A sort that narrows the page but not the total is a pager that lies. */
    it('leaves the where untouched — findMany and count still agree', async () => {
      await service.list(query({ sort: 'ending', standing: 'EXPIRING' }), ALL_SCOPE, NOW);

      const findMany = (prisma.user.findMany.mock.calls[0][0] as { where: Prisma.UserWhereInput })
        .where;
      const count = (prisma.user.count.mock.calls[0][0] as { where: Prisma.UserWhereInput }).where;
      expect(count).toEqual(findMany);
    });
  });

  /**
   * The KPI tiles. The point of the endpoint is that the numbers and the
   * table are built from ONE filter builder, so a tile reading 42 beside a
   * filter showing 39 is structurally impossible.
   */
  describe('counts', () => {
    function capturedCountWheres(): Prisma.UserWhereInput[] {
      return prisma.user.count.mock.calls.map(
        (call) => (call[0] as { where: Prisma.UserWhereInput }).where,
      );
    }

    beforeEach(() => {
      prisma.user.count
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(16);
    });

    it('issues exactly five counts, in one $transaction', async () => {
      await service.counts(countsQuery(), ALL_SCOPE, NOW);

      expect(prisma.user.count).toHaveBeenCalledTimes(5);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(Array.isArray(prisma.$transaction.mock.calls[0][0])).toBe(true);
    });

    it('returns the five numbers in the order they were counted', async () => {
      const result = await service.counts(countsQuery(), ALL_SCOPE, NOW);

      expect(result).toEqual({
        active: 10,
        expiring: 3,
        expired: 2,
        none: 4,
        total: 16,
        expiringSoonDays: 7,
      });
    });

    it('reads expiringSoonDays from GymConfigService, never a literal', async () => {
      const result = await service.counts(countsQuery(), ALL_SCOPE, NOW);

      expect(result.expiringSoonDays).toBe(7);
    });

    it('applies search and planCode to EVERY branch, standing to none of them', async () => {
      await service.counts(countsQuery({ search: 'marisol', planCode: 'MONTHLY' }), ALL_SCOPE, NOW);

      const wheres = capturedCountWheres();
      expect(wheres).toHaveLength(5);
      for (const where of wheres) {
        const [filters] = (where as { AND: Prisma.UserWhereInput[] }).AND;
        expect(filters).toHaveProperty('OR');
        const inner = (filters as { AND: Prisma.UserWhereInput[] }).AND;
        expect(inner).toContainEqual({ membership: { planCode: 'MONTHLY' } });
      }

      // The LAST branch is `total` — the same filter with NO standing at all,
      // which is what makes "active + expired + none" reconcile against it.
      const totalFilters = (wheres[4] as { AND: Prisma.UserWhereInput[] }).AND[0];
      expect((totalFilters as { AND: Prisma.UserWhereInput[] }).AND).toEqual([
        { membership: { planCode: 'MONTHLY' } },
      ]);
    });

    it("counts the standings the table's chips speak: active, expiring, expired, none", async () => {
      await service.counts(countsQuery(), ALL_SCOPE, NOW);

      const wheres = capturedCountWheres();
      const standings = wheres.map((where) => {
        const filters = (where as { AND: Prisma.UserWhereInput[] }).AND[0];
        return (filters as { AND?: Prisma.UserWhereInput[] }).AND?.[0];
      });

      expect(standings[0]).toEqual({ membership: { endsOn: { gte: expect.anything() } } });
      expect(standings[1]).toEqual({
        membership: { endsOn: { gte: expect.anything(), lte: expect.anything() } },
      });
      expect(standings[2]).toEqual({ membership: { endsOn: { lt: expect.anything() } } });
      expect(standings[3]).toEqual({ membership: null });
      expect(standings[4]).toBeUndefined();
    });

    it('excludes soft-deleted members by default, same as list', async () => {
      await service.counts(countsQuery(), ALL_SCOPE, NOW);

      for (const where of capturedCountWheres()) {
        const [filters, reach] = (where as { AND: Prisma.UserWhereInput[] }).AND;
        expect(filters).toMatchObject({ deletedAt: null });
        expect(reach).toEqual(ALL_SCOPE);
      }
    });

    it('deleted=true uses reachWithoutDeletedGuard, exactly as list does', async () => {
      await service.counts(countsQuery({ deleted: true }), OWN_SCOPE, NOW);

      for (const where of capturedCountWheres()) {
        const [filters, reach] = (where as { AND: Prisma.UserWhereInput[] }).AND;
        expect(filters).toMatchObject({ deletedAt: { not: null } });
        expect(reach).toEqual({
          OR: [
            { id: MEMBER_ID },
            { assignedCoach: { some: { coachId: MEMBER_ID, endedAt: null } } },
          ],
        });
      }
    });
  });

  describe('create', () => {
    function stubHappyPath(): void {
      prisma.user.findFirst.mockResolvedValue(null);
      supabaseAdmin.createAuthUser.mockResolvedValue({ userId: NEW_SUPABASE_ID });
      prisma.user.create.mockResolvedValue(row({ id: MEMBER_ID, supabaseId: NEW_SUPABASE_ID }));
      prisma.user.findUniqueOrThrow.mockResolvedValue(row({ id: MEMBER_ID }));
    }

    it('409s MEMBER_EMAIL_TAKEN on a local email collision, before ever calling Supabase', async () => {
      prisma.user.findFirst.mockResolvedValue(row({ email: 'jon@example.com' }));

      await expect(service.create(createDto(), ADMIN, undefined, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_EMAIL_TAKEN' },
        status: HttpStatus.CONFLICT,
      });
      expect(supabaseAdmin.createAuthUser).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('mints a Supabase user (no link), then creates the User row with that supabaseId and role CLIENT', async () => {
      stubHappyPath();

      await service.create(createDto(), ADMIN, undefined, NOW);

      expect(supabaseAdmin.createAuthUser).toHaveBeenCalledWith('jon@example.com');
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          supabaseId: NEW_SUPABASE_ID,
          email: 'jon@example.com',
          firstName: 'Jon',
          lastName: 'Snow',
          role: Role.CLIENT,
        }),
      });
    });

    it('creates the User row inside a transaction', async () => {
      stubHappyPath();

      await service.create(createDto(), ADMIN, undefined, NOW);

      expect(prisma.$transaction).toHaveBeenCalled();
    });

    const LEAD_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

    it('marks the lead CONVERTED with the new userId, in the same transaction', async () => {
      stubHappyPath();
      prisma.lead.findUnique.mockResolvedValue({
        id: LEAD_ID,
        convertedUserId: null,
        convertedAt: null,
      });
      prisma.lead.update.mockResolvedValue({});

      await service.create(createDto({ leadId: LEAD_ID }), ADMIN, undefined, NOW);

      expect(prisma.lead.update).toHaveBeenCalledWith({
        where: { id: LEAD_ID },
        data: { status: 'CONVERTED', convertedAt: NOW, convertedUserId: MEMBER_ID },
      });
    });

    it('keeps the earlier convertedAt when staff had already pressed "Joined"', async () => {
      stubHappyPath();
      const joined = new Date('2026-08-30T00:00:00.000Z');
      prisma.lead.findUnique.mockResolvedValue({
        id: LEAD_ID,
        convertedUserId: null,
        convertedAt: joined,
      });
      prisma.lead.update.mockResolvedValue({});

      await service.create(createDto({ leadId: LEAD_ID }), ADMIN, undefined, NOW);

      expect(prisma.lead.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ convertedAt: joined }) }),
      );
    });

    it('404s an unknown lead BEFORE minting a Supabase identity', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.lead.findUnique.mockResolvedValue(null);

      await expect(
        service.create(createDto({ leadId: LEAD_ID }), ADMIN, undefined, NOW),
      ).rejects.toMatchObject({
        response: { code: 'LEAD_NOT_FOUND' },
        status: HttpStatus.NOT_FOUND,
      });
      expect(supabaseAdmin.createAuthUser).not.toHaveBeenCalled();
    });

    it('409s a lead already linked to a member — one enquiry, one account', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.lead.findUnique.mockResolvedValue({
        id: LEAD_ID,
        convertedUserId: OTHER_ID,
        convertedAt: NOW,
      });

      await expect(
        service.create(createDto({ leadId: LEAD_ID }), ADMIN, undefined, NOW),
      ).rejects.toMatchObject({
        response: { code: 'LEAD_ALREADY_CONVERTED' },
        status: HttpStatus.CONFLICT,
      });
      expect(supabaseAdmin.createAuthUser).not.toHaveBeenCalled();
    });

    it('never touches the lead table when no leadId is given', async () => {
      stubHappyPath();

      await service.create(createDto(), ADMIN, undefined, NOW);

      expect(prisma.lead.findUnique).not.toHaveBeenCalled();
      expect(prisma.lead.update).not.toHaveBeenCalled();
    });

    it('issues our setup link for the created member, and returns emailSent: true on success', async () => {
      stubHappyPath();

      const result = await service.create(createDto(), ADMIN, 'https://site.test', NOW);

      expect(memberJoin.issue).toHaveBeenCalledWith(
        { userId: MEMBER_ID, issuedById: ADMIN_ID, requestOrigin: 'https://site.test' },
        NOW,
      );
      expect(result.emailSent).toBe(true);
      expect(result.member.userId).toBe(MEMBER_ID);
    });

    it('does not roll back the member when the setup email fails — returns emailSent: false', async () => {
      stubHappyPath();
      memberJoin.issue.mockResolvedValue(false);

      const result = await service.create(createDto(), ADMIN, undefined, NOW);

      expect(result.emailSent).toBe(false);
      expect(result.member.userId).toBe(MEMBER_ID);
      // The member row was still created — the transaction already committed.
      expect(prisma.user.create).toHaveBeenCalled();
    });

    it('deletes the freshly minted Supabase user when the local create fails, then rethrows the ORIGINAL error', async () => {
      stubHappyPath();
      const boom = new Error('unique constraint raced');
      prisma.user.create.mockRejectedValue(boom);
      supabaseAdmin.deleteUser.mockResolvedValue(undefined);

      await expect(service.create(createDto(), ADMIN, undefined, NOW)).rejects.toBe(boom);

      // The orphan is the identity that was minted moments earlier — not the
      // local row id, which never came to exist.
      expect(supabaseAdmin.deleteUser).toHaveBeenCalledWith(NEW_SUPABASE_ID);
      // No link, no plan sale, no member view: nothing downstream ran.
      expect(memberJoin.issue).not.toHaveBeenCalled();
      expect(sales.sell).not.toHaveBeenCalled();
    });

    it('still surfaces the ORIGINAL failure when the Supabase cleanup itself fails', async () => {
      stubHappyPath();
      const boom = new Error('unique constraint raced');
      prisma.user.create.mockRejectedValue(boom);
      supabaseAdmin.deleteUser.mockRejectedValue(new Error('Supabase is down'));

      // The caller sees the create failure, never the cleanup failure — the
      // cleanup is housekeeping and its own error is logged, not thrown.
      await expect(service.create(createDto(), ADMIN, undefined, NOW)).rejects.toBe(boom);
      expect(supabaseAdmin.deleteUser).toHaveBeenCalledWith(NEW_SUPABASE_ID);
    });

    it('never calls deleteUser on the happy path', async () => {
      stubHappyPath();

      await service.create(createDto(), ADMIN, undefined, NOW);

      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
    });

    it('never calls MembershipSalesService.sell when no plan is given', async () => {
      stubHappyPath();

      await service.create(createDto(), ADMIN, undefined, NOW);

      expect(sales.sell).not.toHaveBeenCalled();
    });

    it('sells the plan for the new member when one is given, after member creation', async () => {
      stubHappyPath();
      sales.sell.mockResolvedValue({ id: 'membership-1' });
      const dto = createDto({
        plan: { planCode: 'MONTHLY', method: 'CASH' } as CreateMemberDto['plan'],
      });

      await service.create(dto, ADMIN, undefined, NOW);

      expect(sales.sell).toHaveBeenCalledWith(
        ADMIN,
        expect.objectContaining({ planCode: 'MONTHLY', method: 'CASH', userId: MEMBER_ID }),
        expect.any(String),
        NOW,
      );
    });

    it('403s when a plan is given but the actor does not hold membership.sell', async () => {
      stubHappyPath();
      permissions.getEffectivePermissions.mockResolvedValue([{ key: 'member.create', scope: 'ALL' }]);
      const dto = createDto({
        plan: { planCode: 'MONTHLY', method: 'CASH' } as CreateMemberDto['plan'],
      });

      await expect(service.create(dto, ADMIN, undefined, NOW)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      });
      // Refused before minting a Supabase user or creating anything.
      expect(supabaseAdmin.createAuthUser).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('omits planSaleError when the sale succeeds', async () => {
      stubHappyPath();
      sales.sell.mockResolvedValue({ id: 'membership-1' });
      const dto = createDto({
        plan: { planCode: 'MONTHLY', method: 'CASH' } as CreateMemberDto['plan'],
      });

      const result = await service.create(dto, ADMIN, undefined, NOW);

      expect(result.planSaleError).toBeUndefined();
    });

    it('does not throw on a plan-sale failure — returns the member, planSaleError, and still attempts the email', async () => {
      stubHappyPath();
      sales.sell.mockRejectedValue(
        new DomainException('SHIFT_NOT_OPEN', 'Open a shift before selling.', HttpStatus.CONFLICT),
      );
      const dto = createDto({
        plan: { planCode: 'MONTHLY', method: 'CASH' } as CreateMemberDto['plan'],
      });

      const result = await service.create(dto, ADMIN, undefined, NOW);

      // The member row itself was already committed and is not undone.
      expect(prisma.user.create).toHaveBeenCalled();
      expect(result.member.userId).toBe(MEMBER_ID);
      expect(result.planSaleError).toEqual({
        code: 'SHIFT_NOT_OPEN',
        message: 'Open a shift before selling.',
      });
      // The member exists regardless of the sale outcome, so the setup
      // link still goes out — and the stub's mocked issue succeeds.
      expect(memberJoin.issue).toHaveBeenCalled();
      expect(result.emailSent).toBe(true);
    });

    it('falls back to a generic planSaleError code/message for a non-DomainException sale failure', async () => {
      stubHappyPath();
      sales.sell.mockRejectedValue(new Error('connection reset'));
      const dto = createDto({
        plan: { planCode: 'MONTHLY', method: 'CASH' } as CreateMemberDto['plan'],
      });

      const result = await service.create(dto, ADMIN, undefined, NOW);

      expect(result.planSaleError).toEqual({
        code: 'PLAN_SALE_FAILED',
        message: 'connection reset',
      });
    });

    it('reflects an actual email failure in emailSent even when the plan sale also failed', async () => {
      stubHappyPath();
      sales.sell.mockRejectedValue(new Error('connection reset'));
      memberJoin.issue.mockResolvedValue(false);
      const dto = createDto({
        plan: { planCode: 'MONTHLY', method: 'CASH' } as CreateMemberDto['plan'],
      });

      const result = await service.create(dto, ADMIN, undefined, NOW);

      expect(result.planSaleError).toBeDefined();
      expect(result.emailSent).toBe(false);
    });

    it('issues the link AFTER the plan sale, so the email can name the plan', async () => {
      stubHappyPath();
      const order: string[] = [];
      sales.sell.mockImplementation(async () => {
        order.push('sell');
        return { id: 'membership-1' };
      });
      memberJoin.issue.mockImplementation(async () => {
        order.push('issue');
        return true;
      });
      const dto = createDto({
        plan: { planCode: 'MONTHLY', method: 'CASH' } as CreateMemberDto['plan'],
      });

      await service.create(dto, ADMIN, undefined, NOW);

      expect(order).toEqual(['sell', 'issue']);
    });

    it('still returns the member, emailSent: false, when issuing the link throws', async () => {
      stubHappyPath();
      memberJoin.issue.mockRejectedValue(new Error('db'));

      const result = await service.create(createDto(), ADMIN, undefined, NOW);

      // The account exists, and "Resend invite" issues a fresh link, so a link
      // failure must never lose it.
      expect(result.emailSent).toBe(false);
      expect(result.member.userId).toBe(MEMBER_ID);
      expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
    });
  });

  describe('resendInvite', () => {
    it('404s on a scoped miss, same as any other member route, and issues nothing', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.resendInvite(MEMBER_ID, ALL_SCOPE, ADMIN, undefined, NOW),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_NOT_FOUND' } });
      expect(memberJoin.issue).not.toHaveBeenCalled();
    });

    it('rotates the setup link through MemberJoinService.issue and returns its emailSent', async () => {
      prisma.user.findFirst.mockResolvedValue(row());
      memberJoin.issue.mockResolvedValue(false);

      const result = await service.resendInvite(
        MEMBER_ID,
        ALL_SCOPE,
        ADMIN,
        'https://site.test',
        NOW,
      );

      expect(memberJoin.issue).toHaveBeenCalledWith(
        { userId: MEMBER_ID, issuedById: ADMIN_ID, requestOrigin: 'https://site.test' },
        NOW,
      );
      expect(result.member.userId).toBe(MEMBER_ID);
      expect(result.emailSent).toBe(false);
    });

    it.each([
      ['MEMBER_ALREADY_SIGNED_IN', 'They have already signed in.'],
      ['MEMBER_JOIN_STAFF_ACCOUNT', 'Staff accounts are set up from Staff & Access.'],
    ] as const)('lets a %s refusal from issue propagate unchanged', async (code, message) => {
      prisma.user.findFirst.mockResolvedValue(row());
      const refusal = new DomainException(code, message, HttpStatus.CONFLICT);
      memberJoin.issue.mockRejectedValue(refusal);

      await expect(service.resendInvite(MEMBER_ID, ALL_SCOPE, ADMIN, undefined, NOW)).rejects.toBe(
        refusal,
      );
    });
  });

  describe('changeEmail', () => {
    const SUPABASE_ID = '22222222-2222-4222-8222-222222222222';
    let record: jest.Mock;
    let audited: MembersService;

    beforeEach(() => {
      record = jest.fn().mockResolvedValue(undefined);
      // The actor's role, read by `recordAccountAction` for the audit snapshot.
      prisma.user.findUnique.mockResolvedValue({ role: Role.ADMIN });
      audited = new MembersService(
        prisma as unknown as PrismaService,
        buildGym(),
        supabaseAdmin as unknown as SupabaseAdminService,
        memberJoin as unknown as MemberJoinService,
        permissions as unknown as PermissionsService,
        sales as unknown as MembershipSalesService,
        { record } as unknown as AuditService,
      );
    });

    /** The scoped read, then the "does anybody else hold it" read, then `findOne`'s. */
    function stubReads(over: Record<string, unknown> = {}, holder: unknown = null): void {
      prisma.user.findFirst
        .mockResolvedValueOnce(row({ supabaseId: SUPABASE_ID, email: 'old@example.com', ...over }))
        .mockResolvedValueOnce(holder)
        .mockResolvedValueOnce(row({ email: 'new@example.com' }));
    }

    it('moves Supabase first, then the row, audits before/after, and sends the link to the new address', async () => {
      stubReads();
      const order: string[] = [];
      supabaseAdmin.updateAuthEmail.mockImplementation(async () => {
        order.push('supabase');
      });
      prisma.user.update.mockImplementation(async () => {
        order.push('row');
        return {};
      });
      memberJoin.issue.mockImplementation(async () => {
        order.push('issue');
        return true;
      });

      const result = await audited.changeEmail(
        MEMBER_ID,
        'new@example.com',
        ALL_SCOPE,
        ADMIN,
        'https://site.test',
        NOW,
      );

      expect(order).toEqual(['supabase', 'row', 'issue']);
      expect(supabaseAdmin.updateAuthEmail).toHaveBeenCalledWith(SUPABASE_ID, 'new@example.com');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: MEMBER_ID },
        data: { email: 'new@example.com' },
      });
      expect(prisma.user.findFirst).toHaveBeenNthCalledWith(2, {
        where: { email: 'new@example.com', NOT: { id: MEMBER_ID } },
        select: { id: true },
      });
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'MEMBER_EMAIL_CHANGED',
          actorId: ADMIN_ID,
          subjectId: MEMBER_ID,
          details: { before: 'old@example.com', after: 'new@example.com' },
        }),
        NOW,
      );
      expect(memberJoin.issue).toHaveBeenCalledWith(
        { userId: MEMBER_ID, issuedById: ADMIN_ID, requestOrigin: 'https://site.test' },
        NOW,
      );
      expect(result).toEqual({
        member: expect.objectContaining({ userId: MEMBER_ID, email: 'new@example.com' }),
        emailSent: true,
      });
    });

    it('404s a scoped miss before touching anything', async () => {
      prisma.user.findFirst.mockResolvedValueOnce(null);

      await expect(
        audited.changeEmail(MEMBER_ID, 'new@example.com', ALL_SCOPE, ADMIN, undefined, NOW),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_NOT_FOUND' }, status: 404 });
      expect(supabaseAdmin.updateAuthEmail).not.toHaveBeenCalled();
    });

    it.each([Role.COACH, Role.FRONT_DESK, Role.ADMIN])(
      'refuses a %s account — never a way to point a staff login at another inbox',
      async (role) => {
        // Never signed in: the staff refusal answers here even though no
        // signed-in refusal could. The order itself is pinned by the signed-in
        // staff case below.
        stubReads({ role });

        await expect(
          audited.changeEmail(MEMBER_ID, 'new@example.com', ALL_SCOPE, ADMIN, undefined, NOW),
        ).rejects.toMatchObject({ response: { code: 'MEMBER_JOIN_STAFF_ACCOUNT' }, status: 409 });
        expect(supabaseAdmin.updateAuthEmail).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(memberJoin.issue).not.toHaveBeenCalled();
      },
    );

    it('answers a SIGNED-IN staff account with the staff refusal — the role is checked first', async () => {
      stubReads({ role: Role.FRONT_DESK, lastSeenAt: new Date('2026-08-20T00:00:00.000Z') });

      await expect(
        audited.changeEmail(MEMBER_ID, 'new@example.com', ALL_SCOPE, ADMIN, undefined, NOW),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_JOIN_STAFF_ACCOUNT' }, status: 409 });
      expect(supabaseAdmin.updateAuthEmail).not.toHaveBeenCalled();
    });

    /**
     * The old link went to the MISTYPED address — maybe a stranger's inbox — and
     * a claim reads the member's email fresh, so it would sign that stranger into
     * the corrected account. It dies with the email change, in one transaction,
     * not later inside `issue()` where a failure would leave it alive.
     */
    it('kills the unused link in the SAME transaction as the email update', async () => {
      stubReads();
      const tx = {
        user: { update: jest.fn().mockResolvedValue({}) },
        memberJoinLink: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      prisma.$transaction.mockImplementationOnce((fn: (t: typeof tx) => Promise<unknown>) =>
        fn(tx),
      );
      memberJoin.issue.mockResolvedValue(true);

      await audited.changeEmail(MEMBER_ID, 'new@example.com', ALL_SCOPE, ADMIN, undefined, NOW);

      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: MEMBER_ID },
        data: { email: 'new@example.com' },
      });
      expect(tx.memberJoinLink.deleteMany).toHaveBeenCalledWith({
        where: { userId: MEMBER_ID, usedAt: null },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.memberJoinLink.deleteMany).not.toHaveBeenCalled();
    });

    it('puts Supabase back and rethrows the ORIGINAL error when the link delete fails', async () => {
      stubReads();
      prisma.user.update.mockResolvedValue({});
      const boom = new Error('connection reset');
      prisma.memberJoinLink.deleteMany.mockRejectedValue(boom);

      await expect(
        audited.changeEmail(MEMBER_ID, 'new@example.com', ALL_SCOPE, ADMIN, undefined, NOW),
      ).rejects.toBe(boom);
      expect(supabaseAdmin.updateAuthEmail).toHaveBeenNthCalledWith(
        2,
        SUPABASE_ID,
        'old@example.com',
      );
      expect(memberJoin.issue).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('answers emailSent:false, never a 500, when issuing the new link throws — and still audits', async () => {
      stubReads();
      prisma.user.update.mockResolvedValue({});
      memberJoin.issue.mockRejectedValue(new Error('unique violation'));

      await expect(
        audited.changeEmail(MEMBER_ID, 'new@example.com', ALL_SCOPE, ADMIN, undefined, NOW),
      ).resolves.toEqual({
        member: expect.objectContaining({ userId: MEMBER_ID, email: 'new@example.com' }),
        emailSent: false,
      });
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'MEMBER_EMAIL_CHANGED' }),
        NOW,
      );
    });

    it('refuses a member who has signed in, touching neither Supabase nor the row', async () => {
      stubReads({ lastSeenAt: new Date('2026-08-20T00:00:00.000Z') });

      await expect(
        audited.changeEmail(MEMBER_ID, 'new@example.com', ALL_SCOPE, ADMIN, undefined, NOW),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_ALREADY_SIGNED_IN' }, status: 409 });
      expect(supabaseAdmin.updateAuthEmail).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(memberJoin.issue).not.toHaveBeenCalled();
    });

    it('refuses the address they already have as a no-op 409', async () => {
      stubReads();

      await expect(
        audited.changeEmail(MEMBER_ID, 'old@example.com', ALL_SCOPE, ADMIN, undefined, NOW),
      ).rejects.toMatchObject({
        response: { code: 'MEMBER_EMAIL_TAKEN', message: 'That is already their email.' },
        status: 409,
      });
      expect(supabaseAdmin.updateAuthEmail).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses an address another account holds, before calling Supabase', async () => {
      stubReads({}, { id: OTHER_ID });

      await expect(
        audited.changeEmail(MEMBER_ID, 'new@example.com', ALL_SCOPE, ADMIN, undefined, NOW),
      ).rejects.toMatchObject({
        response: {
          code: 'MEMBER_EMAIL_TAKEN',
          message: 'A member with this email already exists.',
        },
        status: 409,
      });
      expect(supabaseAdmin.updateAuthEmail).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('puts the Supabase email back when the row update fails, and rethrows the ORIGINAL error', async () => {
      stubReads();
      const boom = new Error('User_email_key');
      prisma.user.update.mockRejectedValue(boom);

      await expect(
        audited.changeEmail(MEMBER_ID, 'new@example.com', ALL_SCOPE, ADMIN, undefined, NOW),
      ).rejects.toBe(boom);
      expect(supabaseAdmin.updateAuthEmail).toHaveBeenNthCalledWith(
        1,
        SUPABASE_ID,
        'new@example.com',
      );
      expect(supabaseAdmin.updateAuthEmail).toHaveBeenNthCalledWith(
        2,
        SUPABASE_ID,
        'old@example.com',
      );
      expect(memberJoin.issue).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('logs at error level when the revert fails too, and still rethrows the ORIGINAL error', async () => {
      stubReads();
      const boom = new Error('User_email_key');
      prisma.user.update.mockRejectedValue(boom);
      supabaseAdmin.updateAuthEmail
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Supabase is down'));
      const logger = (audited as unknown as { logger: { error: (msg: string) => void } }).logger;
      const logged = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

      await expect(
        audited.changeEmail(MEMBER_ID, 'new@example.com', ALL_SCOPE, ADMIN, undefined, NOW),
      ).rejects.toBe(boom);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(SUPABASE_ID));
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('Supabase is down'));
      expect(memberJoin.issue).not.toHaveBeenCalled();
    });
  });
});
