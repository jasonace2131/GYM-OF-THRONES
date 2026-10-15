import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainException } from '../common/exceptions/domain.exception';
import { CoachAssignmentsService } from './coach-assignments.service';
import type { ScopedWhere } from '../rbac/scope.util';
import type { PermissionUser } from '../rbac/rbac.types';
import type { PrismaService } from '../prisma/prisma.service';
import type { ListCoachAssignmentsQueryDto } from './dto/list-coach-assignments-query.dto';
import { COACH_ASSIGNMENT_INCLUDE } from './coach-assignment.presenter';

const COACH_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';

const OWN_SCOPE = {
  OR: [{ coachId: COACH_ID }, { memberId: COACH_ID }],
} as unknown as ScopedWhere<Prisma.CoachAssignmentWhereInput>;

const ALL_SCOPE = {} as unknown as ScopedWhere<Prisma.CoachAssignmentWhereInput>;

const CALLER: PermissionUser = { id: COACH_ID, role: 'COACH', permissionVersion: 0 };

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    coachId: COACH_ID,
    memberId: MEMBER_ID,
    status: 'ACTIVE',
    activeMemberId: MEMBER_ID,
    startedAt: new Date('2026-08-18T02:00:00.000Z'),
    endedAt: null,
    assignedById: ACTOR_ID,
    endedById: null,
    notes: null,
    createdAt: new Date('2026-08-18T02:00:00.000Z'),
    updatedAt: new Date('2026-08-18T02:00:00.000Z'),
    // Every read in this module carries COACH_ASSIGNMENT_INCLUDE, so a fixture
    // without these two would be a shape the service can never actually see.
    coach: { firstName: 'Ana', lastName: 'Cruz' },
    member: { firstName: 'Juan', lastName: 'Dela Cruz', memberCode: 'GOT-0007' },
    ...overrides,
  };
}

function query(
  overrides: Partial<ListCoachAssignmentsQueryDto> = {},
): ListCoachAssignmentsQueryDto {
  return { page: 1, limit: 10, activeOnly: true, ...overrides };
}

interface PrismaMock {
  coachAssignment: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  user: { findUnique: jest.Mock };
  $transaction: jest.Mock;
}

function buildPrisma(): PrismaMock {
  const coachAssignment = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  const prisma: PrismaMock = {
    coachAssignment,
    user: { findUnique: jest.fn() },
    // Both forms are used: the array form by list(), the callback form by
    // create(). Branching here keeps one mock honest for both.
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg as Promise<unknown>[])
        : (arg as (tx: unknown) => Promise<unknown>)(prisma),
    ),
  };
  return prisma;
}

describe('CoachAssignmentsService', () => {
  let prisma: PrismaMock;
  let service: CoachAssignmentsService;

  beforeEach(() => {
    prisma = buildPrisma();
    service = new CoachAssignmentsService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('ANDs the scope fragment rather than spreading it', async () => {
      prisma.coachAssignment.findMany.mockResolvedValue([row()]);
      prisma.coachAssignment.count.mockResolvedValue(1);

      const result = await service.list(CALLER, query({ memberId: MEMBER_ID }), OWN_SCOPE);

      expect(prisma.coachAssignment.findMany).toHaveBeenCalledWith({
        where: { AND: [{ memberId: MEMBER_ID, status: 'ACTIVE' }, OWN_SCOPE] },
        include: COACH_ASSIGNMENT_INCLUDE,
        orderBy: { startedAt: 'desc' },
        skip: 0,
        take: 10,
      });
      expect(prisma.coachAssignment.count).toHaveBeenCalledWith({
        where: { AND: [{ memberId: MEMBER_ID, status: 'ACTIVE' }, OWN_SCOPE] },
      });
      expect(result).toEqual({
        items: [
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            coachId: COACH_ID,
            coachName: 'Ana Cruz',
            memberId: MEMBER_ID,
            memberName: 'Juan Dela Cruz',
            memberCode: 'GOT-0007',
            status: 'ACTIVE',
            startedAt: '2026-08-18T02:00:00.000Z',
            endedAt: null,
            assignedById: ACTOR_ID,
            endedById: null,
            notes: null,
          },
        ],
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      });
    });

    it('omits the status filter when activeOnly is false', async () => {
      prisma.coachAssignment.findMany.mockResolvedValue([]);
      prisma.coachAssignment.count.mockResolvedValue(0);

      await service.list(CALLER, query({ activeOnly: false }), ALL_SCOPE);

      expect(prisma.coachAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { AND: [{}, ALL_SCOPE] } }),
      );
    });
  });

  describe('findOne', () => {
    it('404s rather than 403s when the row exists outside the scope', async () => {
      prisma.coachAssignment.findFirst.mockResolvedValue(null);

      await expect(service.findOne('missing-id', OWN_SCOPE)).rejects.toMatchObject({
        response: { code: 'COACH_ASSIGNMENT_NOT_FOUND' },
      });
      await expect(service.findOne('missing-id', OWN_SCOPE)).rejects.toBeInstanceOf(
        DomainException,
      );
      expect(prisma.coachAssignment.findFirst).toHaveBeenCalledWith({
        where: { AND: [{ id: 'missing-id' }, OWN_SCOPE] },
        include: COACH_ASSIGNMENT_INCLUDE,
      });
    });
  });

  describe('create', () => {
    it('rejects self-assignment before touching the database', async () => {
      await expect(
        service.create(ACTOR_ID, { coachId: COACH_ID, memberId: COACH_ID }),
      ).rejects.toMatchObject({ response: { code: 'COACH_SELF_ASSIGNMENT' } });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a coach whose role is not COACH, ADMIN or DEV', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: COACH_ID, role: 'CLIENT', deletedAt: null })
        .mockResolvedValueOnce({ id: MEMBER_ID, role: 'CLIENT', deletedAt: null });

      const failure = service.create(ACTOR_ID, { coachId: COACH_ID, memberId: MEMBER_ID });

      await expect(failure).rejects.toMatchObject({ response: { code: 'COACH_NOT_A_COACH' } });
      expect(prisma.coachAssignment.create).not.toHaveBeenCalled();
    });

    it('soft-ends the incumbent before inserting, in one transaction', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: COACH_ID, role: 'COACH', deletedAt: null })
        .mockResolvedValueOnce({ id: MEMBER_ID, role: 'CLIENT', deletedAt: null });
      prisma.coachAssignment.updateMany.mockResolvedValue({ count: 1 });
      prisma.coachAssignment.create.mockResolvedValue(row());

      await service.create(ACTOR_ID, { coachId: COACH_ID, memberId: MEMBER_ID, notes: 'strength' });

      const endOrder = prisma.coachAssignment.updateMany.mock.invocationCallOrder[0];
      const insertOrder = prisma.coachAssignment.create.mock.invocationCallOrder[0];
      expect(endOrder).toBeLessThan(insertOrder);

      expect(prisma.coachAssignment.updateMany).toHaveBeenCalledWith({
        where: { memberId: MEMBER_ID, status: 'ACTIVE' },
        data: {
          status: 'ENDED',
          endedAt: expect.any(Date) as Date,
          endedById: ACTOR_ID,
          activeMemberId: null,
        },
      });
      expect(prisma.coachAssignment.create).toHaveBeenCalledWith({
        include: COACH_ASSIGNMENT_INCLUDE,
        data: {
          coachId: COACH_ID,
          memberId: MEMBER_ID,
          activeMemberId: MEMBER_ID,
          assignedById: ACTOR_ID,
          notes: 'strength',
        },
      });
    });

    it('turns the activeMemberId unique violation into 409 MEMBER_ALREADY_ASSIGNED', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: COACH_ID, role: 'COACH', deletedAt: null })
        .mockResolvedValueOnce({ id: MEMBER_ID, role: 'CLIENT', deletedAt: null });
      prisma.coachAssignment.updateMany.mockResolvedValue({ count: 0 });
      prisma.coachAssignment.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.0',
          meta: { target: ['activeMemberId'] },
        }),
      );

      const failure = service.create(ACTOR_ID, { coachId: COACH_ID, memberId: MEMBER_ID });

      await expect(failure).rejects.toMatchObject({
        response: { code: 'MEMBER_ALREADY_ASSIGNED' },
        status: HttpStatus.CONFLICT,
      });
    });
  });

  describe('end', () => {
    it('is idempotent — an already-ended row is returned unchanged', async () => {
      const ended = row({
        status: 'ENDED',
        activeMemberId: null,
        endedAt: new Date('2026-08-18T09:00:00.000Z'),
        endedById: ACTOR_ID,
      });
      prisma.coachAssignment.findFirst.mockResolvedValue(ended);

      const view = await service.end(ACTOR_ID, ended['id'] as string, OWN_SCOPE);

      expect(prisma.coachAssignment.update).not.toHaveBeenCalled();
      expect(view.endedAt).toBe('2026-08-18T09:00:00.000Z');
    });

    it('clears the sentinel when it ends a live row', async () => {
      prisma.coachAssignment.findFirst.mockResolvedValue(row());
      prisma.coachAssignment.update.mockResolvedValue(
        row({ status: 'ENDED', activeMemberId: null, endedAt: new Date(), endedById: ACTOR_ID }),
      );

      await service.end(ACTOR_ID, row()['id'] as string, OWN_SCOPE);

      expect(prisma.coachAssignment.update).toHaveBeenCalledWith({
        where: { id: row()['id'] },
        include: COACH_ASSIGNMENT_INCLUDE,
        data: {
          status: 'ENDED',
          endedAt: expect.any(Date) as Date,
          endedById: ACTOR_ID,
          activeMemberId: null,
        },
      });
    });

    it('404s rather than 403s when the row exists outside the scope, ANDing scope into the findFirst', async () => {
      prisma.coachAssignment.findFirst.mockResolvedValue(null);

      await expect(service.end(ACTOR_ID, 'missing-id', OWN_SCOPE)).rejects.toMatchObject({
        response: { code: 'COACH_ASSIGNMENT_NOT_FOUND' },
      });
      expect(prisma.coachAssignment.findFirst).toHaveBeenCalledWith({
        where: { AND: [{ id: 'missing-id' }, OWN_SCOPE] },
        include: COACH_ASSIGNMENT_INCLUDE,
      });
    });
  });
});
