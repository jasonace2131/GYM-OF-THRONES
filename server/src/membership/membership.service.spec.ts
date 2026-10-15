import type { Membership, MembershipHold, Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import { asCivilDate } from '../common/time/gym-time';
import type { DayPassResolver } from './day-pass.resolver';
import { BOOKING_SUBJECT_SELECT, MembershipService } from './membership.service';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** Only the columns the mappers read; the rest of the row is irrelevant here. */
function membershipWithHolds(holds: Partial<MembershipHold>[]): Membership & {
  holds: MembershipHold[];
} {
  return {
    id: 'mem-1',
    userId: U1,
    status: 'ACTIVE',
    planCode: 'QUARTERLY',
    planName: 'Quarterly',
    planPriceCentavos: 210000,
    startsOn: day('2026-08-01'),
    endsOn: day('2026-10-31'),
    graceDays: 3,
    graceAdmissionsThisTerm: 0,
    cancelRequestedOn: null,
    holds: holds as MembershipHold[],
  } as unknown as Membership & { holds: MembershipHold[] };
}

/** What `user.findFirst/findMany({ select: BOOKING_SUBJECT_SELECT })` resolves to. */
function userRow(id: string, membership: ReturnType<typeof membershipWithHolds> | null) {
  return { id, status: 'ACTIVE' as const, membership };
}

function prismaMock() {
  return {
    user: { findFirst: jest.fn(), findMany: jest.fn() },
    membership: { findUnique: jest.fn() },
  };
}

function build() {
  const prisma = prismaMock();
  const gym = {
    timeZone: 'Asia/Manila',
    expiringSoonDays: 7,
    graceAdmissionsMax: 3,
  } as GymConfigService;
  const dayPasses = { validToday: jest.fn().mockResolvedValue(false) };
  const service = new MembershipService(
    prisma as unknown as PrismaService,
    gym,
    dayPasses as DayPassResolver,
  );
  return { prisma, dayPasses, service };
}

/** A transaction client is just another set of delegates; the loaders must use it. */
const asTx = (mock: ReturnType<typeof prismaMock>): Prisma.TransactionClient =>
  mock as unknown as Prisma.TransactionClient;

describe('BOOKING_SUBJECT_SELECT', () => {
  it('loads holds by STATUS — the running one and every booked one — never by window', () => {
    // An early release marks a hold COMPLETED and leaves its endsOn in place,
    // so a window filter would keep a member frozen after a manager released
    // them. And a SCHEDULED filter alone would hide the running hold.
    expect(BOOKING_SUBJECT_SELECT.membership.include.holds.where).toEqual({
      status: { in: ['SCHEDULED', 'ACTIVE'] },
    });
  });

  it("reads the account status beside the membership, for the ladder's gates", () => {
    expect(BOOKING_SUBJECT_SELECT.status).toBe(true);
    expect(BOOKING_SUBJECT_SELECT.id).toBe(true);
  });
});

describe('MembershipService.loadBookingSubject', () => {
  it('reads one user, soft-deleted ones excluded, through the booking select', async () => {
    const { prisma, service } = build();
    prisma.user.findFirst.mockResolvedValue(userRow(U1, null));

    await service.loadBookingSubject(U1);

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: U1, deletedAt: null },
      select: BOOKING_SUBJECT_SELECT,
    });
  });

  it('is null — never a throw — for a missing or soft-deleted user', async () => {
    const { prisma, service } = build();
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(service.loadBookingSubject(U1)).resolves.toBeNull();
  });

  it('maps the row: the running hold to the snapshot, the booked ones to the projection', async () => {
    const { prisma, service } = build();
    prisma.user.findFirst.mockResolvedValue(
      userRow(
        U1,
        membershipWithHolds([
          {
            status: 'ACTIVE',
            startsOn: day('2026-08-10'),
            endsOn: day('2026-08-23'),
            daysRequested: 14,
          },
          {
            status: 'SCHEDULED',
            startsOn: day('2026-09-20'),
            endsOn: day('2026-09-26'),
            daysRequested: 7,
          },
        ]),
      ),
    );

    const subject = await service.loadBookingSubject(U1);

    expect(subject).toMatchObject({
      userStatus: 'ACTIVE',
      planCode: 'QUARTERLY',
      scheduledHolds: [{ startsOn: '2026-09-20', endsOn: '2026-09-26', daysRequested: 7 }],
    });
    expect(subject?.membership).toMatchObject({
      status: 'ACTIVE',
      endsOn: '2026-10-31',
      hold: { startsOn: '2026-08-10', endsOn: '2026-08-23' },
    });
  });

  it('reads on the transaction it is given, not the pooled client', async () => {
    const { prisma, service } = build();
    const tx = prismaMock();
    tx.user.findFirst.mockResolvedValue(userRow(U1, null));

    const subject = await service.loadBookingSubject(U1, asTx(tx));

    expect(tx.user.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(subject?.membership).toBeNull();
  });

  it('resolves no day pass: a walk-in never counts for a class', async () => {
    const { prisma, dayPasses, service } = build();
    prisma.user.findFirst.mockResolvedValue(userRow(U1, null));

    await service.loadBookingSubject(U1);

    expect(dayPasses.validToday).not.toHaveBeenCalled();
  });
});

describe('MembershipService.loadBookingSubjects', () => {
  it('reads everybody in ONE query, each id once', async () => {
    const { prisma, service } = build();
    prisma.user.findMany.mockResolvedValue([]);

    await service.loadBookingSubjects([U1, U2, U1]);

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: [U1, U2] }, deletedAt: null },
      select: BOOKING_SUBJECT_SELECT,
    });
  });

  it('keys the result by user id, and a missing or soft-deleted user is simply absent', async () => {
    const { prisma, service } = build();
    prisma.user.findMany.mockResolvedValue([userRow(U1, membershipWithHolds([]))]);

    const subjects = await service.loadBookingSubjects([U1, U2]);

    expect([...subjects.keys()]).toEqual([U1]);
    expect(subjects.get(U1)?.planCode).toBe('QUARTERLY');
    expect(subjects.get(U2)).toBeUndefined();
  });

  it('costs no query for an empty list', async () => {
    const { prisma, service } = build();

    const subjects = await service.loadBookingSubjects([]);

    expect(subjects.size).toBe(0);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('reads on the transaction it is given, not the pooled client', async () => {
    const { prisma, service } = build();
    const tx = prismaMock();
    tx.user.findMany.mockResolvedValue([userRow(U2, null)]);

    const subjects = await service.loadBookingSubjects([U2], asTx(tx));

    expect(tx.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(subjects.get(U2)?.membership).toBeNull();
  });
});

/**
 * The door's loader is deliberately NOT the booking one. Check-in (twice),
 * /me, the assistant and the check-ins report all read `holds[0]` as the
 * running hold; widening this include to SCHEDULED holds would freeze members
 * at the door on days they are not frozen.
 */
describe('MembershipService.loadSubjectAndRow — the door loader is unchanged', () => {
  const TODAY = asCivilDate('2026-08-14');

  it('still loads only the running hold', async () => {
    const { prisma, service } = build();
    prisma.user.findFirst.mockResolvedValue({ id: U1, status: 'ACTIVE' });
    prisma.membership.findUnique.mockResolvedValue(null);

    await service.loadSubjectAndRow(U1, TODAY);

    expect(prisma.membership.findUnique).toHaveBeenCalledWith({
      where: { userId: U1 },
      include: { holds: { where: { activeMembershipId: { not: null } }, take: 1 } },
    });
  });

  it('still 404s a soft-deleted user, as its callers expect', async () => {
    const { prisma, service } = build();
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(service.loadSubjectAndRow(U1, TODAY)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MEMBER_NOT_FOUND' }),
    });
  });
});
