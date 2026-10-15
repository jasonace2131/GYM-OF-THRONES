import { HttpStatus } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { CoachProfilesService } from './coach-profiles.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ScopedWhere } from '../rbac/scope.util';

const NOW = new Date('2026-09-25T04:00:00.000Z');
const COACH_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ADMIN = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: Role.ADMIN };
const ALL_SCOPE = { deletedAt: null } as unknown as ScopedWhere<Prisma.UserWhereInput>;

function build() {
  const prisma = {
    user: { findFirst: jest.fn() },
    coachProfile: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn() },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new CoachProfilesService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { prisma, audit, service };
}

const coachRow = { id: COACH_ID, firstName: 'Ana', lastName: 'Cruz' };

describe('CoachProfilesService', () => {
  describe('get', () => {
    it('404s anybody who is not a live coach — one answer, no oracle', async () => {
      const { prisma, service } = build();
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.get(COACH_ID, ALL_SCOPE)).rejects.toMatchObject({
        response: { code: 'COACH_NOT_FOUND' },
        status: HttpStatus.NOT_FOUND,
      });
      const [{ where }] = prisma.user.findFirst.mock.calls[0] as [
        { where: { AND: Prisma.UserWhereInput[] } },
      ];
      expect(where.AND[0]).toEqual({ id: COACH_ID, role: Role.COACH });
      expect(where.AND[1]).toBe(ALL_SCOPE);
    });

    it('answers an empty profile, updatedAt null, for a coach nobody has written up', async () => {
      const { prisma, service } = build();
      prisma.user.findFirst.mockResolvedValue(coachRow);
      prisma.coachProfile.findUnique.mockResolvedValue(null);

      await expect(service.get(COACH_ID, ALL_SCOPE)).resolves.toEqual({
        userId: COACH_ID,
        specializations: [],
        bio: null,
        updatedAt: null,
      });
    });

    it('returns the stored profile', async () => {
      const { prisma, service } = build();
      prisma.user.findFirst.mockResolvedValue(coachRow);
      prisma.coachProfile.findUnique.mockResolvedValue({
        userId: COACH_ID,
        specializations: ['Strength'],
        bio: 'Ten years coaching.',
        updatedAt: NOW,
      });

      await expect(service.get(COACH_ID, ALL_SCOPE)).resolves.toEqual({
        userId: COACH_ID,
        specializations: ['Strength'],
        bio: 'Ten years coaching.',
        updatedAt: NOW.toISOString(),
      });
    });
  });

  describe('list', () => {
    it('returns the profiles of live coaches within the caller reach', async () => {
      const { prisma, service } = build();
      prisma.coachProfile.findMany.mockResolvedValue([
        { userId: COACH_ID, specializations: ['Mobility'], bio: null, updatedAt: NOW },
      ]);

      const rows = await service.list(ALL_SCOPE);

      expect(prisma.coachProfile.findMany).toHaveBeenCalledWith({
        where: { user: { AND: [{ role: Role.COACH }, ALL_SCOPE] } },
      });
      expect(rows).toEqual([
        {
          userId: COACH_ID,
          specializations: ['Mobility'],
          bio: null,
          updatedAt: NOW.toISOString(),
        },
      ]);
    });
  });

  describe('update', () => {
    it('404s a target who is not a live coach, and writes nothing', async () => {
      const { prisma, service } = build();
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.update(ADMIN, COACH_ID, { specializations: ['Strength'], bio: null }, NOW),
      ).rejects.toMatchObject({ response: { code: 'COACH_NOT_FOUND' } });
      expect(prisma.coachProfile.upsert).not.toHaveBeenCalled();
    });

    it('trims, drops blanks and de-duplicates specializations case-insensitively; blanks the bio to null', async () => {
      const { prisma, service } = build();
      prisma.user.findFirst.mockResolvedValue(coachRow);
      prisma.coachProfile.findUnique.mockResolvedValue(null);
      prisma.coachProfile.upsert.mockImplementation(
        ({ create }: { create: Record<string, unknown> }) =>
          Promise.resolve({ ...create, updatedAt: NOW }),
      );

      const view = await service.update(
        ADMIN,
        COACH_ID,
        { specializations: [' Strength ', 'strength', '', 'Mobility'], bio: '   ' },
        NOW,
      );

      expect(prisma.coachProfile.upsert).toHaveBeenCalledWith({
        where: { userId: COACH_ID },
        create: {
          userId: COACH_ID,
          specializations: ['Strength', 'Mobility'],
          bio: null,
          updatedById: ADMIN.id,
        },
        update: { specializations: ['Strength', 'Mobility'], bio: null, updatedById: ADMIN.id },
      });
      expect(view).toMatchObject({ specializations: ['Strength', 'Mobility'], bio: null });
    });

    it('records COACH_PROFILE_UPDATED with the specializations before/after, never the bio text', async () => {
      const { prisma, audit, service } = build();
      prisma.user.findFirst.mockResolvedValue(coachRow);
      prisma.coachProfile.findUnique.mockResolvedValue({
        userId: COACH_ID,
        specializations: ['Strength'],
        bio: 'Old bio',
        updatedAt: NOW,
      });
      prisma.coachProfile.upsert.mockResolvedValue({
        userId: COACH_ID,
        specializations: ['Strength', 'Boxing'],
        bio: 'New bio',
        updatedAt: NOW,
      });

      await service.update(
        ADMIN,
        COACH_ID,
        { specializations: ['Strength', 'Boxing'], bio: 'New bio' },
        NOW,
      );

      expect(audit.record).toHaveBeenCalledWith(
        {
          action: 'COACH_PROFILE_UPDATED',
          actorId: ADMIN.id,
          actorRole: Role.ADMIN,
          subjectType: 'User',
          subjectId: COACH_ID,
          subjectLabel: 'Ana Cruz',
          details: {
            specializations: { before: 'Strength', after: 'Strength, Boxing' },
            bioChanged: true,
          },
        },
        NOW,
      );
    });
  });
});
