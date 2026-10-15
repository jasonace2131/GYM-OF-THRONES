import { MemberAnnouncementsService, PINNED_MAX } from './member-announcements.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AnnouncementRow } from './announcement.presenter';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-24T04:00:00.000Z');
const DAY = 86_400_000;

/** A member of ten days who has never opened the bell: floor = createdAt. */
const CREATED_AT = new Date(NOW.getTime() - 10 * DAY);

function row(id: string, createdAt: Date, isPinned = false): AnnouncementRow {
  return {
    id,
    title: `Notice ${id}`,
    content: 'Body',
    contentJson: null,
    coverImageUrl: null,
    isPinned,
    createdAt,
    updatedAt: createdAt,
    author: { id: 'a1', firstName: 'Ana', lastName: 'Cruz' },
  };
}

interface PrismaMock {
  user: { findUniqueOrThrow: jest.Mock; updateMany: jest.Mock };
  announcement: { findMany: jest.Mock; count: jest.Mock };
  $transaction: jest.Mock;
}

function build(user: { announcementsSeenAt: Date | null; createdAt: Date }) {
  const prisma: PrismaMock = {
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(user),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    announcement: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { prisma, service: new MemberAnnouncementsService(prisma as unknown as PrismaService) };
}

describe('MemberAnnouncementsService.feed', () => {
  it('reads the member once, then runs page, total, pinned and unread in ONE transaction', async () => {
    const { prisma, service } = build({ announcementsSeenAt: null, createdAt: CREATED_AT });
    const fresh = row('n2', new Date(NOW.getTime() - DAY));
    const old = row('n1', new Date(NOW.getTime() - 20 * DAY));
    const pinned = row('p1', new Date(NOW.getTime() - 40 * DAY), true);
    prisma.announcement.findMany
      .mockResolvedValueOnce([fresh, old])
      .mockResolvedValueOnce([pinned]);
    prisma.announcement.count.mockResolvedValueOnce(23).mockResolvedValueOnce(1);

    const feed = await service.feed(USER_ID, { page: 2, limit: 5 }, NOW);

    expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { announcementsSeenAt: true, createdAt: true },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect((prisma.$transaction.mock.calls[0] as unknown[][])[0]).toHaveLength(4);

    // The page: chronological, offset-paginated, author named.
    expect(prisma.announcement.findMany).toHaveBeenNthCalledWith(1, {
      include: { author: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 5,
      take: 5,
    });
    // Pinned: independent of the page, newest first, capped.
    expect(prisma.announcement.findMany).toHaveBeenNthCalledWith(2, {
      where: { isPinned: true },
      include: { author: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PINNED_MAX,
    });
    expect(prisma.announcement.count).toHaveBeenNthCalledWith(1);
    // Unread: strictly after the effective watermark.
    expect(prisma.announcement.count).toHaveBeenNthCalledWith(2, {
      where: { createdAt: { gt: CREATED_AT } },
    });

    expect(feed).toMatchObject({ page: 2, limit: 5, total: 23, totalPages: 5, unreadCount: 1 });
    expect(feed.items.map((item) => [item.id, item.isNew])).toEqual([
      ['n2', true],
      ['n1', false],
    ]);
    expect(feed.pinned.map((item) => [item.id, item.isNew])).toEqual([['p1', false]]);
  });

  it('caps pinned at five', () => {
    expect(PINNED_MAX).toBe(5);
  });

  it('floors an old member at the 30-day horizon', async () => {
    const { prisma, service } = build({
      announcementsSeenAt: null,
      createdAt: new Date(NOW.getTime() - 400 * DAY),
    });
    prisma.announcement.findMany.mockResolvedValue([]);
    prisma.announcement.count.mockResolvedValue(0);

    await service.feed(USER_ID, { page: 1, limit: 10 }, NOW);

    expect(prisma.announcement.count).toHaveBeenNthCalledWith(2, {
      where: { createdAt: { gt: new Date(NOW.getTime() - 30 * DAY) } },
    });
  });
});

describe('MemberAnnouncementsService.markSeen', () => {
  const upTo = new Date(NOW.getTime() - 3_600_000);

  /**
   * MONOTONIC, in the database. The guard lives in the WHERE of a single
   * UPDATE, so two tabs opening the bell at once cannot interleave a
   * read-then-write and drag the watermark backwards.
   */
  it('writes only when the mark moves the watermark forward', async () => {
    const { prisma, service } = build({ announcementsSeenAt: null, createdAt: CREATED_AT });
    prisma.announcement.count.mockResolvedValue(0);

    await service.markSeen(USER_ID, upTo, NOW);

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        OR: [
          // Never opened: the effective watermark is createdAt, so only a mark
          // past it moves anything. Writing an older mark would REWIND it.
          { announcementsSeenAt: null, createdAt: { lt: upTo } },
          { announcementsSeenAt: { lt: upTo } },
        ],
      },
      data: { announcementsSeenAt: upTo },
    });
  });

  it('clamps a future upTo to now before writing', async () => {
    const { prisma, service } = build({ announcementsSeenAt: null, createdAt: CREATED_AT });
    prisma.announcement.count.mockResolvedValue(0);

    await service.markSeen(USER_ID, new Date('2099-01-01T00:00:00.000Z'), NOW);

    const call = prisma.user.updateMany.mock.calls[0] as [{ data: { announcementsSeenAt: Date } }];
    expect(call[0].data.announcementsSeenAt).toEqual(NOW);
  });

  it('re-reads after the write and returns the effective watermark and the count', async () => {
    const stored = new Date(NOW.getTime() - 60_000);
    const { prisma, service } = build({ announcementsSeenAt: stored, createdAt: CREATED_AT });
    prisma.announcement.count.mockResolvedValue(2);

    const result = await service.markSeen(USER_ID, upTo, NOW);

    // The re-read comes AFTER the update, so a concurrent newer write wins.
    const [updateOrder] = prisma.user.updateMany.mock.invocationCallOrder;
    const [readOrder] = prisma.user.findUniqueOrThrow.mock.invocationCallOrder;
    expect(readOrder).toBeGreaterThan(updateOrder ?? Infinity);

    expect(prisma.announcement.count).toHaveBeenCalledWith({
      where: { createdAt: { gt: stored } },
    });
    expect(result).toEqual({ seenAt: stored.toISOString(), unreadCount: 2 });
  });
});
