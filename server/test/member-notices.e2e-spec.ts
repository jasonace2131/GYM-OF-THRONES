import { Logger } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'http';
import type { MemberNoticeFeedWire, MemberNoticesSeenWire } from '@got/shared';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import {
  MemberNoticesService,
  type MemberNoticeInput,
} from '../src/notifications/member-notices.service';

jest.setTimeout(120_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const MINUTE = 60_000;

/**
 * A member's own notices, end to end: `GET /me/notices`, `POST /me/notices/seen`
 * and the producer-facing `notify()` against the real table.
 *
 * Unlike announcements, the read state is a column on each row (`readAt`), so
 * several assertions read the rows themselves — proving the write is scoped to
 * the caller and monotonic in the DATABASE, not only in the response.
 */
describe('member notices (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let tokenA: string;
  let memberA: string;
  let tokenB: string;
  let memberB: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    tokenA = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
    memberA = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);
    tokenB = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_B });
    memberB = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_B);
  });

  /** One notice, written straight to the table with an explicit instant. */
  async function notice(
    userId: string,
    title: string,
    createdAt: Date,
    extra: { id?: string; readAt?: Date | null } = {},
  ): Promise<{ id: string; createdAt: Date }> {
    return ctx.prisma.memberNotice.create({
      data: {
        ...(extra.id === undefined ? {} : { id: extra.id }),
        userId,
        kind: 'CLASS_CANCELLED',
        title,
        body: 'Coach is unwell.',
        linkPath: '/portal/book?date=2026-10-14',
        readAt: extra.readAt ?? null,
        createdAt,
      },
      select: { id: true, createdAt: true },
    });
  }

  async function feed(token: string, query = ''): Promise<MemberNoticeFeedWire> {
    const response = await request(server)
      .get(`/api/v1/me/notices${query}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return (response.body as Envelope<MemberNoticeFeedWire>).data as MemberNoticeFeedWire;
  }

  async function seen(token: string, upTo: string): Promise<MemberNoticesSeenWire> {
    const response = await request(server)
      .post('/api/v1/me/notices/seen')
      .set('Authorization', `Bearer ${token}`)
      .send({ upTo })
      .expect(200);
    return (response.body as Envelope<MemberNoticesSeenWire>).data as MemberNoticesSeenWire;
  }

  async function readAtOf(id: string): Promise<Date | null> {
    const row = await ctx.prisma.memberNotice.findUniqueOrThrow({
      where: { id },
      select: { readAt: true },
    });
    return row.readAt;
  }

  describe('GET /me/notices', () => {
    it('401s without a token, on both routes', async () => {
      await request(server).get('/api/v1/me/notices').expect(401);
      await request(server)
        .post('/api/v1/me/notices/seen')
        .send({ upTo: new Date().toISOString() })
        .expect(401);
    });

    it('shows a member only their own notices, and counts only their own unread', async () => {
      const now = Date.now();
      await notice(memberA, 'A, older', new Date(now - 3 * MINUTE));
      await notice(memberA, 'A, read', new Date(now - 2 * MINUTE), {
        readAt: new Date(now - MINUTE),
      });
      await notice(memberB, 'B, newest', new Date(now - MINUTE));

      const forA = await feed(tokenA);
      expect(forA.items.map((item) => [item.title, item.isNew])).toEqual([
        ['A, read', false],
        ['A, older', true],
      ]);
      expect(forA).toMatchObject({ total: 2, unreadCount: 1 });

      const forB = await feed(tokenB);
      expect(forB.items.map((item) => item.title)).toEqual(['B, newest']);
      expect(forB).toMatchObject({ total: 1, unreadCount: 1 });
    });

    it('pages newest first, the id breaking a tie, with the counts independent of the page', async () => {
      const now = Date.now();
      const tie = new Date(now - 2 * MINUTE);
      await notice(memberA, 'Oldest', new Date(now - 3 * MINUTE));
      await notice(memberA, 'Tie, lower id', tie, { id: '7a000000-0000-4000-8000-00000000000a' });
      await notice(memberA, 'Tie, higher id', tie, { id: '7a000000-0000-4000-8000-00000000000b' });
      await notice(memberA, 'Newest', new Date(now - MINUTE));

      const first = await feed(tokenA, '?page=1&limit=3');
      const second = await feed(tokenA, '?page=2&limit=3');

      expect(first.items.map((item) => item.title)).toEqual([
        'Newest',
        'Tie, higher id',
        'Tie, lower id',
      ]);
      expect(second.items.map((item) => item.title)).toEqual(['Oldest']);
      expect(first).toMatchObject({ page: 1, limit: 3, total: 4, totalPages: 2, unreadCount: 4 });
      expect(second).toMatchObject({ page: 2, total: 4, unreadCount: 4 });
    });

    it("sends the wire shape and nothing of the producer's bookkeeping", async () => {
      const { id, createdAt } = await notice(memberA, 'Cancelled: Spin', new Date());

      const [item] = (await feed(tokenA)).items;

      expect(item).toEqual({
        id,
        kind: 'CLASS_CANCELLED',
        title: 'Cancelled: Spin',
        body: 'Coach is unwell.',
        linkPath: '/portal/book?date=2026-10-14',
        isNew: true,
        createdAt: createdAt.toISOString(),
      });
    });
  });

  describe('POST /me/notices/seen', () => {
    it('marks what the member was shown and leaves a newer notice lit', async () => {
      const now = Date.now();
      const older = await notice(memberA, 'Older', new Date(now - 3 * MINUTE));
      const shown = await notice(memberA, 'Shown', new Date(now - 2 * MINUTE));
      const newer = await notice(memberA, 'Arrived after the GET', new Date(now - MINUTE));
      const before = Date.now();

      const result = await seen(tokenA, shown.createdAt.toISOString());

      expect(result).toEqual({ unreadCount: 1 });
      for (const id of [older.id, shown.id]) {
        const stamp = (await readAtOf(id)) as Date;
        expect(stamp.getTime()).toBeGreaterThanOrEqual(before);
        expect(stamp.getTime()).toBeLessThanOrEqual(Date.now());
      }
      expect(await readAtOf(newer.id)).toBeNull();
      const after = await feed(tokenA);
      expect(after.items.map((item) => [item.title, item.isNew])).toEqual([
        ['Arrived after the GET', true],
        ['Shown', false],
        ['Older', false],
      ]);
    });

    it('is monotonic: an older mark never re-stamps a read notice or un-reads one', async () => {
      const now = Date.now();
      const first = await notice(memberA, 'First', new Date(now - 3 * MINUTE));
      await seen(tokenA, first.createdAt.toISOString());
      const stamped = (await readAtOf(first.id)) as Date;
      const later = await notice(memberA, 'Later', new Date(now - MINUTE));

      // A second tab still showing an older list, or a replay.
      const result = await seen(tokenA, new Date(now - 10 * MINUTE).toISOString());

      expect(result).toEqual({ unreadCount: 1 });
      expect(await readAtOf(first.id)).toEqual(stamped);
      expect(await readAtOf(later.id)).toBeNull();

      // The same mark again changes nothing either.
      await seen(tokenA, first.createdAt.toISOString());
      expect(await readAtOf(first.id)).toEqual(stamped);
      expect(await readAtOf(later.id)).toBeNull();
    });

    it('clamps a future upTo to now, so a notice stamped ahead of the clock stays lit', async () => {
      const ahead = await notice(
        memberA,
        'Written by a clock that runs fast',
        new Date(Date.now() + 60 * MINUTE),
      );
      const past = await notice(memberA, 'Ordinary', new Date(Date.now() - MINUTE));

      const result = await seen(tokenA, '2099-01-01T00:00:00.000Z');

      expect(result).toEqual({ unreadCount: 1 });
      expect(await readAtOf(past.id)).not.toBeNull();
      expect(await readAtOf(ahead.id)).toBeNull();
    });

    it("touches only the caller's notices", async () => {
      const now = Date.now();
      await notice(memberA, 'Mine', new Date(now - 2 * MINUTE));
      const theirs = await notice(memberB, 'Theirs', new Date(now - 2 * MINUTE));

      await seen(tokenA, new Date(now).toISOString());

      expect(await readAtOf(theirs.id)).toBeNull();
      expect((await feed(tokenB)).unreadCount).toBe(1);
      expect((await feed(tokenA)).unreadCount).toBe(0);
    });

    it('400s on a body that names a userId, and on anything but one readable instant', async () => {
      const theirs = await notice(memberB, 'Theirs', new Date(Date.now() - MINUTE));
      const post = () =>
        request(server).post('/api/v1/me/notices/seen').set('Authorization', `Bearer ${tokenA}`);

      await post().send({ upTo: new Date().toISOString(), userId: memberB }).expect(400);
      await post().send({}).expect(400);
      await post().send({ upTo: 'yesterday' }).expect(400);
      // ISO 8601, but nothing `new Date()` can read: a 400, never a 500.
      await post().send({ upTo: '2026-W41' }).expect(400);

      expect(await readAtOf(theirs.id)).toBeNull();
    });
  });

  describe('MemberNoticesService.notify (the producer side, against the real table)', () => {
    const input = (over: Partial<MemberNoticeInput> = {}): MemberNoticeInput => ({
      userId: memberA,
      kind: 'CLASS_PROMOTED',
      title: "You're in: Spin, Wed 14 Oct 6:00 pm",
      body: "A place opened up and it's yours.",
      linkPath: '/portal/book?date=2026-10-14',
      dedupeKey: 'CLASS_PROMOTED:e2e:1',
      ...over,
    });

    it('writes once per dedupe key: a repeat is skipped, not refused, and the batch lands', async () => {
      const notices = ctx.app.get(MemberNoticesService, { strict: false });

      await notices.notify([
        input(),
        input({ userId: memberB, dedupeKey: 'CLASS_PROMOTED:e2e:2' }),
      ]);
      await notices.notify([
        input(),
        input({ title: 'Another', dedupeKey: null }),
        input({ title: 'And another', dedupeKey: null }),
      ]);

      const forA = await feed(tokenA);
      expect(forA.items.map((item) => item.title).sort()).toEqual([
        'And another',
        'Another',
        "You're in: Spin, Wed 14 Oct 6:00 pm",
      ]);
      expect((await feed(tokenB)).total).toBe(1);
    });

    it('never throws, even when the database refuses the whole batch', async () => {
      const notices = ctx.app.get(MemberNoticesService, { strict: false });
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      try {
        // A well-formed id that names nobody: the foreign key refuses the INSERT.
        await expect(
          notices.notify([input({ userId: '7a000000-0000-4000-8000-0000000000ff' })]),
        ).resolves.toBeUndefined();
        expect(error).toHaveBeenCalledTimes(1);
      } finally {
        error.mockRestore();
      }
      expect((await feed(tokenA)).total).toBe(0);
    });
  });
});
