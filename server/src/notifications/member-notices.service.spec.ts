import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { MemberNoticesService, type MemberNoticeInput } from './member-notices.service';
import type { MemberNoticeRow } from './member-notice.presenter';
import type { PrismaService } from '../prisma/prisma.service';

const MEMBER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BOOKING = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-11T04:00:00.000Z');
const MINUTE = 60_000;

interface PrismaMock {
  memberNotice: {
    createMany: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    updateMany: jest.Mock;
  };
  $transaction: jest.Mock;
}

function build(): { prisma: PrismaMock; service: MemberNoticesService } {
  const prisma: PrismaMock = {
    memberNotice: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { prisma, service: new MemberNoticesService(prisma as unknown as PrismaService) };
}

function input(over: Partial<MemberNoticeInput> = {}): MemberNoticeInput {
  return {
    userId: MEMBER,
    kind: 'CLASS_PROMOTED',
    title: "You're in: Spin, Wed 14 Oct 6:00 pm",
    body: "A place opened up and it's yours.",
    linkPath: '/portal/book?date=2026-10-14',
    subjectType: 'ClassBooking',
    subjectId: BOOKING,
    dedupeKey: `CLASS_PROMOTED:${BOOKING}:1760000000000`,
    ...over,
  };
}

/** The rows of the one createMany call. */
function written(prisma: PrismaMock): Prisma.MemberNoticeCreateManyInput[] {
  expect(prisma.memberNotice.createMany).toHaveBeenCalledTimes(1);
  const [args] = prisma.memberNotice.createMany.mock.calls[0] as [
    { data: Prisma.MemberNoticeCreateManyInput[]; skipDuplicates: boolean },
  ];
  return args.data;
}

function row(id: string, createdAt: Date, readAt: Date | null = null): MemberNoticeRow {
  return {
    id,
    kind: 'CLASS_CANCELLED',
    title: `Notice ${id}`,
    body: null,
    linkPath: '/portal/book',
    readAt,
    createdAt,
  };
}

let warn: jest.SpyInstance;
let error: jest.SpyInstance;

beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('MemberNoticesService.notify', () => {
  it('writes the whole batch in ONE createMany that skips duplicates', async () => {
    const { prisma, service } = build();

    await service.notify([
      input(),
      input({
        userId: OTHER,
        kind: 'CLASS_CANCELLED',
        title: 'Cancelled: Spin, Wed 14 Oct 6:00 pm',
        body: 'Coach is unwell.',
        subjectType: 'ClassSession',
        subjectId: SESSION,
        dedupeKey: `CLASS_CANCELLED:${SESSION}:${OTHER}`,
      }),
    ]);

    expect(prisma.memberNotice.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: MEMBER,
          kind: 'CLASS_PROMOTED',
          title: "You're in: Spin, Wed 14 Oct 6:00 pm",
          body: "A place opened up and it's yours.",
          linkPath: '/portal/book?date=2026-10-14',
          subjectType: 'ClassBooking',
          subjectId: BOOKING,
          dedupeKey: `CLASS_PROMOTED:${BOOKING}:1760000000000`,
        },
        {
          userId: OTHER,
          kind: 'CLASS_CANCELLED',
          title: 'Cancelled: Spin, Wed 14 Oct 6:00 pm',
          body: 'Coach is unwell.',
          linkPath: '/portal/book?date=2026-10-14',
          subjectType: 'ClassSession',
          subjectId: SESSION,
          dedupeKey: `CLASS_CANCELLED:${SESSION}:${OTHER}`,
        },
      ],
      skipDuplicates: true,
    });
  });

  it('sends NULL, not undefined, for everything a producer left out', async () => {
    const { prisma, service } = build();

    await service.notify([{ userId: MEMBER, kind: 'BOOKING_ADDED', title: 'Booked by the desk' }]);

    expect(written(prisma)).toEqual([
      {
        userId: MEMBER,
        kind: 'BOOKING_ADDED',
        title: 'Booked by the desk',
        body: null,
        linkPath: null,
        subjectType: null,
        subjectId: null,
        dedupeKey: null,
      },
    ]);
  });

  /**
   * THE CONTRACT THE PRODUCERS DEPEND ON. Every caller has already committed
   * a seat, a cancellation or a removal; if this threw, a dropped connection
   * would turn that committed change into an error response and invite a
   * retry of a write that already happened.
   */
  it('swallows a database failure, and logs it, rather than failing its caller', async () => {
    const { prisma, service } = build();
    prisma.memberNotice.createMany.mockRejectedValue(new Error('connection reset'));

    await expect(service.notify([input()])).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      'could not write 1 member notice(s) (CLASS_PROMOTED)',
      expect.stringContaining('connection reset'),
    );
  });

  it('does not touch the database for an empty batch', async () => {
    const { prisma, service } = build();

    await service.notify([]);

    expect(prisma.memberNotice.createMany).not.toHaveBeenCalled();
  });

  it('trims the title, and cuts one over 120 characters with an ellipsis', async () => {
    const { prisma, service } = build();
    const exact = 'x'.repeat(120);

    await service.notify([
      input({ title: `  ${exact}\n` }),
      input({ title: `${'y'.repeat(118)} and more`, dedupeKey: null }),
    ]);

    const [kept, cut] = written(prisma);
    expect(kept?.title).toBe(exact);
    // 119 kept, the trailing space before the cut dropped, then the ellipsis.
    expect(cut?.title).toBe(`${'y'.repeat(118)}…`);
    expect(Array.from(cut?.title ?? '')).toHaveLength(119);
  });

  /** `char_length` counts code points; `String.length` counts UTF-16 units. */
  it('counts characters the way the CHECK does, and never splits one', async () => {
    const { prisma, service } = build();
    const fits = '💪'.repeat(120); // 120 characters, but 240 UTF-16 units

    await service.notify([
      input({ title: fits }),
      input({ title: '💪'.repeat(121), dedupeKey: null }),
    ]);

    const [whole, cut] = written(prisma);
    expect(whole?.title).toBe(fits);
    expect(cut?.title).toBe(`${'💪'.repeat(119)}…`);
    expect(Array.from(cut?.title ?? '')).toHaveLength(120);
  });

  it('trims the body, cuts it at 1000, and stores a blank one as no body', async () => {
    const { prisma, service } = build();

    await service.notify([
      input({ body: `  ${'b'.repeat(1000)}  ` }),
      input({ body: 'c'.repeat(1001), dedupeKey: 'two' }),
      input({ body: ' \t\r\n ', dedupeKey: 'three' }),
      input({ body: null, dedupeKey: 'four' }),
    ]);

    const [exact, cut, blank, none] = written(prisma);
    expect(exact?.body).toBe('b'.repeat(1000));
    expect(cut?.body).toBe(`${'c'.repeat(999)}…`);
    expect(blank?.body).toBeNull();
    expect(none?.body).toBeNull();
  });

  /**
   * One INSERT carries the batch and Postgres refuses it as a whole, so a row
   * the CHECK would reject must not reach it: it would cost every other member
   * in the batch their notice.
   */
  it('drops a notice with a blank title, and only that one', async () => {
    const { prisma, service } = build();

    await service.notify([input({ title: ' \t\n ', dedupeKey: 'blank' }), input()]);

    expect(written(prisma).map((data) => data.dedupeKey)).toEqual([
      `CLASS_PROMOTED:${BOOKING}:1760000000000`,
    ]);
    expect(warn).toHaveBeenCalledWith('dropped a CLASS_PROMOTED notice: its title is blank');
  });

  it('drops a notice addressed to something that is not a user id', async () => {
    const { prisma, service } = build();

    await service.notify([input({ userId: 'everyone' })]);

    expect(prisma.memberNotice.createMany).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps an in-app path and leaves off anything else, sending the notice anyway', async () => {
    const { prisma, service } = build();
    const links = [
      '/portal/book?date=2026-10-14',
      'https://evil.example/portal',
      '//evil.example',
      '/\\evil.example',
      'portal/book',
      '',
    ];

    await service.notify(links.map((linkPath, i) => input({ linkPath, dedupeKey: `k${i}` })));

    expect(written(prisma).map((data) => data.linkPath)).toEqual([
      '/portal/book?date=2026-10-14',
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('names a subject only as a type AND a uuid, never half of one', async () => {
    const { prisma, service } = build();

    await service.notify([
      input({ subjectType: 'ClassBooking', subjectId: null, dedupeKey: 'a' }),
      input({ subjectType: null, subjectId: BOOKING, dedupeKey: 'b' }),
      input({ subjectType: 'ClassBooking', subjectId: 'booking-7', dedupeKey: 'c' }),
      input({ dedupeKey: 'd' }),
    ]);

    expect(written(prisma).map((data) => [data.subjectType, data.subjectId])).toEqual([
      [null, null],
      [null, null],
      [null, null],
      ['ClassBooking', BOOKING],
    ]);
  });
});

describe('MemberNoticesService.feed', () => {
  it('runs the page, the total and the unread count in ONE transaction, scoped to the member', async () => {
    const { prisma, service } = build();
    const fresh = row('n2', new Date(NOW.getTime() - MINUTE));
    const seen = row(
      'n1',
      new Date(NOW.getTime() - 60 * MINUTE),
      new Date(NOW.getTime() - 30 * MINUTE),
    );
    prisma.memberNotice.findMany.mockResolvedValue([fresh, seen]);
    prisma.memberNotice.count.mockResolvedValueOnce(12).mockResolvedValueOnce(4);

    const feed = await service.feed(MEMBER, { page: 2, limit: 5 });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect((prisma.$transaction.mock.calls[0] as unknown[][])[0]).toHaveLength(3);

    expect(prisma.memberNotice.findMany).toHaveBeenCalledWith({
      where: { userId: MEMBER },
      select: {
        id: true,
        kind: true,
        title: true,
        body: true,
        linkPath: true,
        readAt: true,
        createdAt: true,
      },
      // Newest first, the id breaking ties, so a page boundary is stable.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 5,
      take: 5,
    });
    expect(prisma.memberNotice.count).toHaveBeenNthCalledWith(1, { where: { userId: MEMBER } });
    expect(prisma.memberNotice.count).toHaveBeenNthCalledWith(2, {
      where: { userId: MEMBER, readAt: null },
    });

    expect(feed).toEqual({
      items: [
        {
          id: 'n2',
          kind: 'CLASS_CANCELLED',
          title: 'Notice n2',
          body: null,
          linkPath: '/portal/book',
          isNew: true,
          createdAt: fresh.createdAt.toISOString(),
        },
        {
          id: 'n1',
          kind: 'CLASS_CANCELLED',
          title: 'Notice n1',
          body: null,
          linkPath: '/portal/book',
          isNew: false,
          createdAt: seen.createdAt.toISOString(),
        },
      ],
      total: 12,
      page: 2,
      limit: 5,
      totalPages: 3,
      unreadCount: 4,
    });
  });

  it('reports page 1 of 1 for a member with no notices', async () => {
    const { prisma, service } = build();
    prisma.memberNotice.findMany.mockResolvedValue([]);
    prisma.memberNotice.count.mockResolvedValue(0);

    await expect(service.feed(MEMBER, { page: 1, limit: 10 })).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      limit: 10,
      totalPages: 1,
      unreadCount: 0,
    });
  });
});

describe('MemberNoticesService.markSeen', () => {
  const upTo = new Date(NOW.getTime() - 5 * MINUTE);

  /**
   * MONOTONIC, in the database: one guarded UPDATE that touches only rows
   * still unread, so a second tab or an older mark can neither re-stamp a
   * notice already read nor un-read one.
   */
  it("stamps now on the member's unread notices up to the mark, and nothing else", async () => {
    const { prisma, service } = build();
    prisma.memberNotice.count.mockResolvedValue(0);

    await service.markSeen(MEMBER, upTo, NOW);

    expect(prisma.memberNotice.updateMany).toHaveBeenCalledWith({
      where: { userId: MEMBER, readAt: null, createdAt: { lte: upTo } },
      data: { readAt: NOW },
    });
  });

  it('clamps a future upTo to now before writing', async () => {
    const { prisma, service } = build();
    prisma.memberNotice.count.mockResolvedValue(0);

    await service.markSeen(MEMBER, new Date('2099-01-01T00:00:00.000Z'), NOW);

    expect(prisma.memberNotice.updateMany).toHaveBeenCalledWith({
      where: { userId: MEMBER, readAt: null, createdAt: { lte: NOW } },
      data: { readAt: NOW },
    });
  });

  it("recounts the member's unread AFTER the write and returns only that", async () => {
    const { prisma, service } = build();
    prisma.memberNotice.count.mockResolvedValue(2);

    const result = await service.markSeen(MEMBER, upTo, NOW);

    const [writeOrder] = prisma.memberNotice.updateMany.mock.invocationCallOrder;
    const [countOrder] = prisma.memberNotice.count.mock.invocationCallOrder;
    expect(countOrder).toBeGreaterThan(writeOrder ?? Infinity);
    expect(prisma.memberNotice.count).toHaveBeenCalledWith({
      where: { userId: MEMBER, readAt: null },
    });
    expect(result).toEqual({ unreadCount: 2 });
  });
});
