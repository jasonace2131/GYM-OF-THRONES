import { MeController } from './me.controller';
import type { AuthUser } from '../auth/auth.types';

/**
 * `GET /me/coach` — the member's own coach, now with what they specialise in
 * and a short bio (Staff & Access). A member holds no `coach.read`, so this
 * keyless route is the only way their My Coach page learns either.
 */
describe('MeController.myCoach', () => {
  const member = { id: 'm1' } as AuthUser;

  function controllerWith(assignment: unknown) {
    const prisma = {
      coachAssignment: { findUnique: jest.fn().mockResolvedValue(assignment) },
      classSession: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const deps = Array.from({ length: 7 }, () => ({}));
    // Only `prisma` is touched by `myCoach`; the other seven collaborators are
    // inert placeholders.
    const controller = new (MeController as unknown as new (...args: unknown[]) => MeController)(
      prisma,
      ...deps,
    );
    return { controller, prisma };
  }

  it('carries the specializations and bio of the assigned coach', async () => {
    const { controller, prisma } = controllerWith({
      startedAt: new Date('2026-09-01T00:00:00.000Z'),
      coachId: 'c1',
      coach: {
        firstName: 'Ana',
        lastName: 'Cruz',
        avatarUrl: null,
        coachProfile: { specializations: ['Strength', 'Mobility'], bio: 'Ten years coaching.' },
      },
    });

    const result = await controller.myCoach(member);

    expect(result.coach).toEqual({ firstName: 'Ana', lastName: 'Cruz', avatarUrl: null });
    expect(result.profile).toEqual({
      specializations: ['Strength', 'Mobility'],
      bio: 'Ten years coaching.',
    });
    const [{ select }] = prisma.coachAssignment.findUnique.mock.calls[0] as [
      { select: { coach: { select: Record<string, unknown> } } },
    ];
    expect(select.coach.select['coachProfile']).toEqual({
      select: { specializations: true, bio: true },
    });
  });

  it('says "no profile yet" as null, never as an empty card', async () => {
    const { controller } = controllerWith({
      startedAt: new Date('2026-09-01T00:00:00.000Z'),
      coachId: 'c1',
      coach: { firstName: 'Ana', lastName: 'Cruz', avatarUrl: null, coachProfile: null },
    });

    expect((await controller.myCoach(member)).profile).toBeNull();
  });

  it('has no profile when there is no coach', async () => {
    const { controller } = controllerWith(null);
    expect(await controller.myCoach(member)).toEqual({
      coach: null,
      profile: null,
      since: null,
      upcomingClasses: [],
    });
  });
});
