import { MembershipAlertsService } from './membership-alerts.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import type { MembershipService } from './membership.service';
import type { ListMembershipAlertsQueryDto } from './dto/list-membership-alerts-query.dto';
import type { ScopedWhere } from '../rbac/scope.util';
import type { Prisma } from '@prisma/client';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// 2026-10-08 10:00 in Manila.
const NOW = new Date('2026-10-08T02:00:00.000Z');
const ENDS_ON_REF = { __fieldRef: 'Membership.endsOn' };
const SCOPE = {} as ScopedWhere<Prisma.MembershipWhereInput>;

function build(totals: { ending: number; lapsed: number }) {
  const prisma = {
    membership: {
      fields: { endsOn: ENDS_ON_REF },
      count: jest.fn().mockResolvedValueOnce(totals.ending).mockResolvedValueOnce(totals.lapsed),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn((arg: unknown) => Promise.all(arg as Promise<unknown>[])),
  };
  const gym = { timeZone: 'Asia/Manila', expiringSoonDays: 7 } as GymConfigService;
  const memberships = {
    accessConfig: { expiringSoonDays: 7, graceAdmissionsMax: 3 },
  } as unknown as MembershipService;
  const service = new MembershipAlertsService(prisma as unknown as PrismaService, gym, memberships);
  return { prisma, service };
}

function query(over: Partial<ListMembershipAlertsQueryDto> = {}): ListMembershipAlertsQueryDto {
  return { page: 1, limit: 10, archived: false, ...over } as ListMembershipAlertsQueryDto;
}

/** The skip/take each segment's findMany was asked for, by sort direction. */
function reads(findMany: jest.Mock): Record<'ending' | 'lapsed', unknown> {
  const out: Record<'ending' | 'lapsed', unknown> = { ending: null, lapsed: null };
  for (const [arg] of findMany.mock.calls as [
    { orderBy: { endsOn: string }[]; skip: number; take: number },
  ][]) {
    const which = arg.orderBy[0]!.endsOn === 'asc' ? 'ending' : 'lapsed';
    out[which] = { skip: arg.skip, take: arg.take };
  }
  return out;
}

describe('MembershipAlertsService.list — one page across two segments', () => {
  it('fills page 1 with the ending-soon rows first, then tops it up with lapsed ones', async () => {
    const { prisma, service } = build({ ending: 3, lapsed: 40 });

    const page = await service.list(query(), SCOPE, NOW);

    expect(reads(prisma.membership.findMany)).toEqual({
      ending: { skip: 0, take: 3 },
      lapsed: { skip: 0, take: 7 },
    });
    expect(page.total).toBe(43);
  });

  it('skips the ending segment entirely once the page is past it', async () => {
    const { prisma, service } = build({ ending: 3, lapsed: 40 });

    await service.list(query({ page: 3 }), SCOPE, NOW);

    // Page 3 starts at row 20: 3 ending rows are behind it, so lapsed row 17.
    expect(reads(prisma.membership.findMany)).toEqual({
      ending: null,
      lapsed: { skip: 17, take: 10 },
    });
  });

  it('never reads lapsed rows while the ending segment fills the page', async () => {
    const { prisma, service } = build({ ending: 25, lapsed: 40 });

    await service.list(query({ page: 2 }), SCOPE, NOW);

    expect(reads(prisma.membership.findMany)).toEqual({
      ending: { skip: 10, take: 10 },
      lapsed: null,
    });
  });

  it('orders ending soonest first and lapsed most recent first', async () => {
    const { prisma, service } = build({ ending: 1, lapsed: 1 });

    await service.list(query(), SCOPE, NOW);

    const orders = (prisma.membership.findMany.mock.calls as [{ orderBy: unknown }][]).map(
      ([arg]) => arg.orderBy,
    );
    expect(orders).toContainEqual([{ endsOn: 'asc' }, { id: 'asc' }]);
    expect(orders).toContainEqual([{ endsOn: 'desc' }, { id: 'asc' }]);
  });

  it('counts the window from the gym day: today through today + 7', async () => {
    const { prisma, service } = build({ ending: 0, lapsed: 0 });

    await service.list(query(), SCOPE, NOW);

    const endingWhere = (
      prisma.membership.count.mock.calls[0] as [{ where: { AND: unknown[] } }]
    )[0].where.AND[0];
    expect(endingWhere).toEqual({
      endsOn: {
        gte: new Date('2026-10-08T00:00:00.000Z'),
        lte: new Date('2026-10-15T00:00:00.000Z'),
      },
    });
  });

  it('counts ACTIVE-in-grace as lapsed alongside EXPIRED, and leaves CANCELLED out', async () => {
    const { prisma, service } = build({ ending: 0, lapsed: 0 });

    await service.list(query(), SCOPE, NOW);

    const lapsedWhere = (
      prisma.membership.count.mock.calls[1] as [{ where: { AND: unknown[] } }]
    )[0].where.AND[0];
    expect(lapsedWhere).toEqual({
      status: { in: ['ACTIVE', 'EXPIRED'] },
      endsOn: { lt: new Date('2026-10-08T00:00:00.000Z') },
    });
  });

  it('shows only alerts archived for the CURRENT term under Archived', async () => {
    const { prisma, service } = build({ ending: 0, lapsed: 0 });

    await service.list(query({ archived: true }), SCOPE, NOW);

    const where = (prisma.membership.count.mock.calls[0] as [{ where: { AND: unknown[] } }])[0]
      .where;
    expect(where.AND[1]).toEqual({ expiryAlertArchivedFor: { equals: ENDS_ON_REF } });
  });

  it('keeps never-archived rows in the open view rather than letting NULL drop them', async () => {
    const { prisma, service } = build({ ending: 0, lapsed: 0 });

    await service.list(query(), SCOPE, NOW);

    const where = (prisma.membership.count.mock.calls[0] as [{ where: { AND: unknown[] } }])[0]
      .where;
    expect(where.AND[1]).toEqual({
      OR: [
        { expiryAlertArchivedFor: null },
        { NOT: { expiryAlertArchivedFor: { equals: ENDS_ON_REF } } },
      ],
    });
  });
});

describe('MembershipAlertsService.archive / restore', () => {
  const ENDS = new Date('2026-10-10T00:00:00.000Z');

  it('archives against the current end date', async () => {
    const { prisma, service } = build({ ending: 0, lapsed: 0 });
    prisma.membership.findUnique.mockResolvedValue({ endsOn: ENDS, expiryAlertArchivedFor: null });

    await expect(service.archive(ID, NOW)).resolves.toEqual({ archivedFor: '2026-10-10' });
    expect(prisma.membership.update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { expiryAlertArchivedFor: ENDS, expiryAlertArchivedAt: NOW },
    });
  });

  it('keeps the first stamp when archived twice', async () => {
    const { prisma, service } = build({ ending: 0, lapsed: 0 });
    prisma.membership.findUnique.mockResolvedValue({ endsOn: ENDS, expiryAlertArchivedFor: ENDS });

    await service.archive(ID, NOW);

    expect(prisma.membership.update).not.toHaveBeenCalled();
  });

  it('re-archives after a renewal moved the end date', async () => {
    const { prisma, service } = build({ ending: 0, lapsed: 0 });
    prisma.membership.findUnique.mockResolvedValue({
      endsOn: ENDS,
      expiryAlertArchivedFor: new Date('2026-09-10T00:00:00.000Z'),
    });

    await service.archive(ID, NOW);

    expect(prisma.membership.update).toHaveBeenCalled();
  });

  it('restores by clearing both columns', async () => {
    const { prisma, service } = build({ ending: 0, lapsed: 0 });
    prisma.membership.findUnique.mockResolvedValue({ endsOn: ENDS, expiryAlertArchivedFor: ENDS });

    await service.restore(ID);

    expect(prisma.membership.update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { expiryAlertArchivedFor: null, expiryAlertArchivedAt: null },
    });
  });

  it('404s an unknown membership', async () => {
    const { prisma, service } = build({ ending: 0, lapsed: 0 });
    prisma.membership.findUnique.mockResolvedValue(null);

    await expect(service.archive(ID, NOW)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MEMBERSHIP_NOT_FOUND' }),
    });
  });
});
