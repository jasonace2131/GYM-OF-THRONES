import { Role } from '@prisma/client';
import { CoachCaseloadService } from './coach-caseload.service';
import type { CoachProfilesService } from './coach-profiles.service';
import type { CoachingService } from '../me/coaching.service';
import type { PrismaService } from '../prisma/prisma.service';

const COACH_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function build() {
  const prisma = { user: { findFirst: jest.fn() } };
  const coaching = { members: jest.fn().mockResolvedValue([{ userId: 'm1' }]) };
  const profiles = {
    get: jest.fn().mockResolvedValue({
      userId: COACH_ID,
      specializations: [],
      bio: null,
      updatedAt: null,
    }),
  };
  const service = new CoachCaseloadService(
    prisma as unknown as PrismaService,
    coaching as unknown as CoachingService,
    profiles as unknown as CoachProfilesService,
  );
  return { prisma, coaching, profiles, service };
}

describe('CoachCaseloadService', () => {
  it("returns the coach, their profile and the SAME caseload rows the coach's own dashboard shows", async () => {
    const { prisma, coaching, service } = build();
    prisma.user.findFirst.mockResolvedValue({
      id: COACH_ID,
      firstName: 'Ana',
      lastName: 'Cruz',
      avatarUrl: null,
      role: Role.COACH,
    });

    const result = await service.caseload(COACH_ID);

    expect(coaching.members).toHaveBeenCalledWith(COACH_ID);
    expect(result).toEqual({
      coach: { id: COACH_ID, firstName: 'Ana', lastName: 'Cruz', avatarUrl: null, role: 'COACH' },
      profile: { userId: COACH_ID, specializations: [], bio: null, updatedAt: null },
      members: [{ userId: 'm1' }],
    });
  });

  it('404s an account that cannot hold a caseload, or is deleted', async () => {
    const { prisma, coaching, service } = build();
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(service.caseload(COACH_ID)).rejects.toMatchObject({
      response: { code: 'COACH_NOT_FOUND' },
    });
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: COACH_ID, role: { in: ['COACH', 'ADMIN', 'DEV'] }, deletedAt: null },
      }),
    );
    expect(coaching.members).not.toHaveBeenCalled();
  });

  it('shows no profile for an admin who coaches — profiles are for the COACH role', async () => {
    const { prisma, profiles, service } = build();
    prisma.user.findFirst.mockResolvedValue({
      id: COACH_ID,
      firstName: 'Maria',
      lastName: 'Santos',
      avatarUrl: null,
      role: Role.ADMIN,
    });

    const result = await service.caseload(COACH_ID);

    expect(profiles.get).not.toHaveBeenCalled();
    expect(result.profile).toBeNull();
  });
});
