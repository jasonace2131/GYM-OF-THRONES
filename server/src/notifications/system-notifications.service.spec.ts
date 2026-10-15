import { SystemNotificationsService } from './system-notifications.service';
import type { PrismaService } from '../prisma/prisma.service';

const ACTOR = '33333333-3333-4333-8333-333333333333';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-09-06T02:00:00.000Z');

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    kind: 'LEAD_RECEIVED',
    severity: 'INFO',
    title: 'New enquiry from Juan',
    body: null,
    linkPath: '/admin/leads',
    subjectType: 'Lead',
    subjectId: '22222222-2222-4222-8222-222222222222',
    readAt: null,
    readById: null,
    resolvedAt: null,
    resolvedById: null,
    createdAt: new Date('2026-09-06T01:00:00.000Z'),
    ...over,
  };
}

interface PrismaMock {
  systemNotification: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    count: jest.Mock;
  };
  $transaction: jest.Mock;
}

function build(): { prisma: PrismaMock; service: SystemNotificationsService } {
  const prisma: PrismaMock = {
    systemNotification: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((arg: unknown) => Promise.all(arg as Promise<unknown>[])),
  };
  return { prisma, service: new SystemNotificationsService(prisma as unknown as PrismaService) };
}

describe('SystemNotificationsService.raise', () => {
  /**
   * THE CONTRACT THE PRODUCERS DEPEND ON.
   *
   * Every caller raises a notification as a side effect of doing something
   * more important — taking an enquiry, running the nightly job. If this threw,
   * a full disk or a dropped connection would cost the gym the ENQUIRY, not
   * just the reminder about it. `ContactService` documents the same discipline
   * for its email send, and this is the same rule one layer down.
   */
  it('swallows a database failure rather than costing its caller their work', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.create.mockRejectedValue(new Error('connection reset'));

    await expect(
      service.raise({ kind: 'LEAD_RECEIVED', title: 'New enquiry from Juan' }),
    ).resolves.toBeUndefined();
  });

  it('lets the database apply its own severity default rather than sending one', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.create.mockResolvedValue(row());

    await service.raise({ kind: 'NIGHTLY_JOB', title: '3 membership changes overnight' });

    const [args] = prisma.systemNotification.create.mock.calls[0] as [{ data: object }];
    expect(args.data).not.toHaveProperty('severity');
  });
});

describe('SystemNotificationsService.markRead', () => {
  it('is idempotent, and the FIRST reader keeps the credit', async () => {
    const { prisma, service } = build();
    const alreadyRead = row({ readAt: new Date('2026-09-06T01:30:00.000Z'), readById: 'someone' });
    prisma.systemNotification.findUnique.mockResolvedValue(alreadyRead);

    const view = await service.markRead(ID, ACTOR, NOW);

    expect(prisma.systemNotification.update).not.toHaveBeenCalled();
    expect(view.readAt).toBe('2026-09-06T01:30:00.000Z');
  });

  it('404s on a notification somebody else already cleared away', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.findUnique.mockResolvedValue(null);

    await expect(service.markRead(ID, ACTOR, NOW)).rejects.toMatchObject({
      response: { code: 'NOTIFICATION_NOT_FOUND' },
    });
  });
});

describe('SystemNotificationsService.resolve', () => {
  /**
   * Acting on something you never ticked as seen is the normal case — somebody
   * reads the title in the list and rings the person back. Leaving it "unread
   * but resolved" would strand it in the Unread filter forever.
   */
  it('marks an unread notification read as well, in the same write', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.findUnique.mockResolvedValue(row());
    prisma.systemNotification.update.mockResolvedValue(
      row({ readAt: NOW, readById: ACTOR, resolvedAt: NOW, resolvedById: ACTOR }),
    );

    await service.resolve(ID, ACTOR, NOW);

    expect(prisma.systemNotification.update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { resolvedAt: NOW, resolvedById: ACTOR, readAt: NOW, readById: ACTOR },
    });
  });

  it('leaves an existing read stamp alone when resolving something already seen', async () => {
    const { prisma, service } = build();
    const seen = new Date('2026-09-06T01:30:00.000Z');
    prisma.systemNotification.findUnique.mockResolvedValue(row({ readAt: seen, readById: 'other' }));
    prisma.systemNotification.update.mockResolvedValue(
      row({ readAt: seen, readById: 'other', resolvedAt: NOW, resolvedById: ACTOR }),
    );

    await service.resolve(ID, ACTOR, NOW);

    expect(prisma.systemNotification.update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { resolvedAt: NOW, resolvedById: ACTOR },
    });
  });

  it('is idempotent — resolving twice does not re-stamp it', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.findUnique.mockResolvedValue(
      row({ resolvedAt: new Date('2026-09-06T01:45:00.000Z'), resolvedById: 'other' }),
    );

    const view = await service.resolve(ID, ACTOR, NOW);

    expect(prisma.systemNotification.update).not.toHaveBeenCalled();
    expect(view.resolvedAt).toBe('2026-09-06T01:45:00.000Z');
  });
});

describe('SystemNotificationsService.list', () => {
  it('hides resolved notices by default and orders unresolved-then-newest', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.findMany.mockResolvedValue([]);

    await service.list({});

    expect(prisma.systemNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ resolvedAt: null }, {}] },
        orderBy: [{ resolvedAt: 'asc' }, { createdAt: 'desc' }],
      }),
    );
  });

  it('drops the resolved filter under All, and can stack Unread on top', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.findMany.mockResolvedValue([]);

    await service.list({ includeResolved: true, unreadOnly: true });

    expect(prisma.systemNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ readAt: null }, {}] } }),
    );
  });

  it('keeps the old 100-row page when a caller sends no paging', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.findMany.mockResolvedValue([]);

    await service.list({});

    expect(prisma.systemNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 100 }),
    );
  });

  it('turns a page number into skip/take, and caps the page size at 100', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.findMany.mockResolvedValue([]);

    await service.list({ page: 3, limit: 10 });
    expect(prisma.systemNotification.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );

    await service.list({ page: 1, limit: 500 });
    expect(prisma.systemNotification.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 0, take: 100 }),
    );
  });

  it('lists only archived notices under Archived, most recently archived first', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.findMany.mockResolvedValue([]);

    // `unreadOnly` alongside is ignored: an archived notice is always read.
    await service.list({ archived: true, unreadOnly: true });

    expect(prisma.systemNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ resolvedAt: { not: null } }, {}] },
        orderBy: [{ resolvedAt: 'desc' }, { createdAt: 'desc' }],
      }),
    );
  });
});

describe('SystemNotificationsService search', () => {
  const SEARCH = {
    OR: [
      { title: { contains: 'juan', mode: 'insensitive' } },
      { body: { contains: 'juan', mode: 'insensitive' } },
    ],
  };

  it('matches title or body, any case, on top of the tab', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.findMany.mockResolvedValue([]);

    await service.list({ search: '  juan ' });

    expect(prisma.systemNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ resolvedAt: null }, SEARCH] } }),
    );
  });

  it('narrows every count by the same search, so the pager total matches the list', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.count.mockResolvedValue(0);

    await service.counts('juan');

    expect(prisma.systemNotification.count).toHaveBeenNthCalledWith(1, {
      where: { AND: [{ readAt: null }, SEARCH] },
    });
    expect(prisma.systemNotification.count).toHaveBeenNthCalledWith(3, {
      where: { AND: [{ resolvedAt: { not: null } }, SEARCH] },
    });
  });
});

describe('SystemNotificationsService.restore', () => {
  it('clears the archive stamp and keeps the read stamp', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.findUnique.mockResolvedValue(
      row({ readAt: NOW, readById: ACTOR, resolvedAt: NOW, resolvedById: ACTOR }),
    );
    prisma.systemNotification.update.mockResolvedValue(row({ readAt: NOW, readById: ACTOR }));

    const restored = await service.restore(ID);

    expect(prisma.systemNotification.update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { resolvedAt: null, resolvedById: null },
    });
    expect(restored.resolvedAt).toBeNull();
    expect(restored.readAt).toBe(NOW.toISOString());
  });

  it('is a no-op on a notice that is not archived', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.findUnique.mockResolvedValue(row());

    await service.restore(ID);

    expect(prisma.systemNotification.update).not.toHaveBeenCalled();
  });
});

describe('SystemNotificationsService.counts', () => {
  /**
   * The list is capped at 100. A badge that counted the page would read "100"
   * against 340 real notices, and a number staff catch out once is a number
   * they stop believing everywhere on the screen.
   */
  it('counts in the database rather than measuring a truncated page', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.count
      .mockResolvedValueOnce(340)
      .mockResolvedValueOnce(400)
      .mockResolvedValueOnce(1200);

    await expect(service.counts()).resolves.toEqual({
      unread: 340,
      unresolved: 400,
      archived: 1200,
    });
    expect(prisma.systemNotification.findMany).not.toHaveBeenCalled();
  });
});

describe('SystemNotificationsService.markAllRead', () => {
  it('touches only what is currently unread', async () => {
    const { prisma, service } = build();
    prisma.systemNotification.updateMany.mockResolvedValue({ count: 7 });

    await expect(service.markAllRead(ACTOR, NOW)).resolves.toEqual({ changed: 7 });
    expect(prisma.systemNotification.updateMany).toHaveBeenCalledWith({
      where: { readAt: null },
      data: { readAt: NOW, readById: ACTOR },
    });
  });
});
