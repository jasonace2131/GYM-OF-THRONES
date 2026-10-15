import { CoachingService } from './coaching.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';

const COACH_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';

/**
 * The gym runs on Asia/Manila (UTC+8), which is the whole reason these tests
 * exist: every boundary below is one a UTC-based implementation gets wrong.
 */
const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;

interface PrismaMock {
  coachAssignment: { count: jest.Mock; findMany: jest.Mock };
  classSession: { count: jest.Mock; findMany: jest.Mock };
  classBooking: { count: jest.Mock; groupBy: jest.Mock };
  checkIn: { groupBy: jest.Mock; findMany: jest.Mock };
  $transaction: jest.Mock;
}

function buildPrisma(): PrismaMock {
  const prisma: PrismaMock = {
    coachAssignment: { count: jest.fn(), findMany: jest.fn() },
    classSession: { count: jest.fn(), findMany: jest.fn() },
    classBooking: { count: jest.fn(), groupBy: jest.fn() },
    checkIn: { groupBy: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn((arg: unknown) => Promise.all(arg as Promise<unknown>[])),
  };
  return prisma;
}

function build(): { prisma: PrismaMock; service: CoachingService } {
  const prisma = buildPrisma();
  return { prisma, service: new CoachingService(prisma as unknown as PrismaService, gym) };
}

describe('CoachingService.summary', () => {
  /**
   * 2026-09-06 is a SUNDAY in Manila. A Monday-start week containing it runs
   * 31 Aug – 6 Sep, so Sunday is the LAST day of its week rather than the
   * first. `getUTCDay()` returns 0 for Sunday, and the naive `day - 0` shift
   * would open the week on the Sunday itself and run it forward into the next
   * one — reporting a coach's Monday classes as belonging to a week that has
   * not started.
   */
  it('opens the week on Monday, with a Sunday falling at its END', async () => {
    const { prisma, service } = build();
    prisma.coachAssignment.count.mockResolvedValue(0);
    prisma.classSession.count.mockResolvedValue(0);
    prisma.classBooking.count.mockResolvedValue(0);

    const result = await service.summary(COACH_ID, new Date('2026-09-06T04:00:00.000Z'));

    expect(result.weekFrom).toBe('2026-08-31');
    expect(result.weekTo).toBe('2026-09-06');
  });

  it('opens the week on the day itself when the day IS a Monday', async () => {
    const { prisma, service } = build();
    prisma.coachAssignment.count.mockResolvedValue(0);
    prisma.classSession.count.mockResolvedValue(0);
    prisma.classBooking.count.mockResolvedValue(0);

    // 2026-08-31 is a Monday.
    const result = await service.summary(COACH_ID, new Date('2026-08-31T04:00:00.000Z'));

    expect(result.weekFrom).toBe('2026-08-31');
    expect(result.weekTo).toBe('2026-09-06');
  });

  /**
   * 16:00 UTC is midnight the NEXT day in Manila. A summary that derived the
   * gym day from the instant's UTC date would file this under the 6th and get
   * both the week and "today" wrong for every evening of the year.
   */
  it('reads the gym-local day, not the UTC one, after 16:00 UTC', async () => {
    const { prisma, service } = build();
    prisma.coachAssignment.count.mockResolvedValue(0);
    prisma.classSession.count.mockResolvedValue(0);
    prisma.classBooking.count.mockResolvedValue(0);

    // 2026-09-06T16:00Z is 2026-09-07 00:00 in Manila — a Monday.
    const result = await service.summary(COACH_ID, new Date('2026-09-06T16:00:00.000Z'));

    expect(result.weekFrom).toBe('2026-09-07');
    expect(result.weekTo).toBe('2026-09-13');
  });

  it('reports the register as marked-of-markable rather than as a percentage', async () => {
    const { prisma, service } = build();
    prisma.coachAssignment.count.mockResolvedValue(4);
    prisma.classSession.count.mockResolvedValueOnce(6).mockResolvedValueOnce(2);
    prisma.classBooking.count.mockResolvedValueOnce(18).mockResolvedValueOnce(12);

    const result = await service.summary(COACH_ID, new Date('2026-09-06T04:00:00.000Z'));

    expect(result).toMatchObject({
      assignedMembers: 4,
      sessionsThisWeek: 6,
      sessionsToday: 2,
      bookedToday: 18,
      markedToday: 12,
    });
  });

  /**
   * "12 of 18 marked" must be able to reach "18 of 18". A waitlist place has
   * no seat and can never be marked (markAttendance refuses it), so counting
   * one made today's register look unfinishable (class-booking fixes,
   * 2026-10-11).
   */
  it('counts seats, never waitlist places, as booked today', async () => {
    const { prisma, service } = build();
    prisma.coachAssignment.count.mockResolvedValue(0);
    prisma.classSession.count.mockResolvedValue(0);
    prisma.classBooking.count.mockResolvedValue(0);

    await service.summary(COACH_ID, new Date('2026-09-06T04:00:00.000Z'));

    const [booked, marked] = prisma.classBooking.count.mock.calls as Array<
      [{ where: { status: { in: string[] } } }]
    >;
    expect(booked?.[0].where.status.in).toEqual(['BOOKED', 'ATTENDED', 'NO_SHOW']);
    expect(marked?.[0].where.status.in).toEqual(['ATTENDED', 'NO_SHOW']);
  });
});

describe('CoachingService.members', () => {
  const assignment = {
    startedAt: new Date('2026-08-18T02:00:00.000Z'),
    member: {
      id: MEMBER_ID,
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      memberCode: 'GOT-0007',
      avatarUrl: null,
    },
  };

  function stubAggregates(prisma: PrismaMock, over: Partial<Record<string, unknown[]>> = {}): void {
    prisma.checkIn.groupBy
      .mockResolvedValueOnce(over['recent'] ?? [])
      .mockResolvedValueOnce(over['last'] ?? []);
    prisma.checkIn.findMany.mockResolvedValue(over['open'] ?? []);
    prisma.classBooking.groupBy
      .mockResolvedValueOnce(over['marked'] ?? [])
      .mockResolvedValueOnce(over['attended'] ?? []);
  }

  it('does not query the aggregates at all when nobody is assigned', async () => {
    const { prisma, service } = build();
    prisma.coachAssignment.findMany.mockResolvedValue([]);

    await expect(service.members(COACH_ID)).resolves.toEqual([]);
    expect(prisma.checkIn.groupBy).not.toHaveBeenCalled();
    expect(prisma.classBooking.groupBy).not.toHaveBeenCalled();
  });

  /**
   * The one number on this screen a member would dispute.
   *
   * Somebody who has never had a class marked has not attended 0% of them —
   * there is no denominator. A rate of 0 would render as "0%" against their
   * name, which is a judgement the data does not support.
   */
  it('reports a NULL attendance rate, never 0%, when nothing has been marked', async () => {
    const { prisma, service } = build();
    prisma.coachAssignment.findMany.mockResolvedValue([assignment]);
    stubAggregates(prisma);

    const [row] = await service.members(COACH_ID);

    expect(row?.attendanceRate).toBeNull();
    expect(row?.classesMarked).toBe(0);
  });

  it('rounds the attendance rate over marked bookings only', async () => {
    const { prisma, service } = build();
    prisma.coachAssignment.findMany.mockResolvedValue([assignment]);
    stubAggregates(prisma, {
      marked: [{ userId: MEMBER_ID, _count: { _all: 3 } }],
      attended: [{ userId: MEMBER_ID, _count: { _all: 2 } }],
    });

    const [row] = await service.members(COACH_ID);

    // 2/3 = 66.66…, and a coach reads a whole number.
    expect(row?.attendanceRate).toBe(67);
  });

  it('flags a member with an open visit as being in the gym now', async () => {
    const { prisma, service } = build();
    prisma.coachAssignment.findMany.mockResolvedValue([assignment]);
    stubAggregates(prisma, {
      open: [{ userId: MEMBER_ID }],
      last: [{ userId: MEMBER_ID, _max: { occurredAt: new Date('2026-09-06T01:00:00.000Z') } }],
      recent: [{ userId: MEMBER_ID, _count: { _all: 9 } }],
    });

    const [row] = await service.members(COACH_ID);

    expect(row?.inGymNow).toBe(true);
    expect(row?.visits30d).toBe(9);
    expect(row?.lastVisitAt).toBe('2026-09-06T01:00:00.000Z');
  });

  /**
   * §4.4: a soft-deleted user is invisible to every member-facing read, and an
   * ACTIVE assignment can outlive the account because the delete is soft and
   * does not cascade. The filter is load-bearing, not defensive.
   */
  it('asks the database to exclude soft-deleted members rather than filtering after', async () => {
    const { prisma, service } = build();
    prisma.coachAssignment.findMany.mockResolvedValue([]);

    await service.members(COACH_ID);

    expect(prisma.coachAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { coachId: COACH_ID, status: 'ACTIVE', member: { deletedAt: null } },
      }),
    );
  });
});

describe('CoachingService.schedule', () => {
  it('defaults to the gym-local week and derives marked from the joined bookings', async () => {
    const { prisma, service } = build();
    prisma.classSession.findMany.mockResolvedValue([
      {
        id: 's1',
        title: 'HIIT',
        startsAt: new Date('2026-09-01T10:00:00.000Z'),
        endsAt: new Date('2026-09-01T11:00:00.000Z'),
        businessDate: new Date('2026-09-01T00:00:00.000Z'),
        capacity: 16,
        bookedCount: 9,
        cancelledAt: null,
        cancelReason: null,
        bookings: [{ status: 'ATTENDED' }, { status: 'ATTENDED' }, { status: 'NO_SHOW' }],
      },
    ]);

    const rows = await service.schedule(COACH_ID, {}, new Date('2026-09-06T04:00:00.000Z'));

    expect(rows[0]).toMatchObject({
      businessDate: '2026-09-01',
      seatsLeft: 7,
      attended: 2,
      noShow: 1,
      marked: 3,
    });
  });

  it('never reports negative seats, even if a count ever exceeded capacity', async () => {
    const { prisma, service } = build();
    prisma.classSession.findMany.mockResolvedValue([
      {
        id: 's1',
        title: 'HIIT',
        startsAt: new Date('2026-09-01T10:00:00.000Z'),
        endsAt: new Date('2026-09-01T11:00:00.000Z'),
        businessDate: new Date('2026-09-01T00:00:00.000Z'),
        capacity: 16,
        bookedCount: 20,
        cancelledAt: null,
        cancelReason: null,
        bookings: [],
      },
    ]);

    const rows = await service.schedule(COACH_ID, {}, new Date('2026-09-06T04:00:00.000Z'));

    expect(rows[0]?.seatsLeft).toBe(0);
  });
});
