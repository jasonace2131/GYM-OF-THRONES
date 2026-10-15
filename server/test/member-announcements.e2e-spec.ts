import request from 'supertest';
import type { Server } from 'http';
import type { AnnouncementsSeen, MemberAnnouncementFeed } from '@got/shared';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';

jest.setTimeout(120_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const DAY = 86_400_000;

/**
 * The member's announcements feed and its watermark, end to end.
 *
 * The watermark is a column (`User.announcementsSeenAt`) the API reads with a
 * floor — createdAt when NULL, never older than 30 days — so every assertion
 * below is about what a real member would see on the badge, and a few read the
 * column itself to prove the write is monotonic in the database, not only in
 * the response.
 */
describe('member announcements (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let adminToken: string;
  let adminId: string;
  let clientToken: string;
  let clientId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
  });

  /** A CLIENT provisioned NOW — every notice inserted before this is history. */
  async function signUpClient(): Promise<void> {
    clientToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
    clientId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);
  }

  async function notice(
    title: string,
    createdAt: Date,
    isPinned = false,
  ): Promise<{ id: string; createdAt: Date }> {
    return ctx.prisma.announcement.create({
      data: { title, content: `${title} — body`, isPinned, authorId: adminId, createdAt },
      select: { id: true, createdAt: true },
    });
  }

  async function feed(query = ''): Promise<MemberAnnouncementFeed> {
    const response = await request(server)
      .get(`/api/v1/me/announcements${query}`)
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(200);
    return (response.body as Envelope<MemberAnnouncementFeed>).data as MemberAnnouncementFeed;
  }

  async function seen(upTo: string): Promise<AnnouncementsSeen> {
    const response = await request(server)
      .post('/api/v1/me/announcements/seen')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ upTo })
      .expect(200);
    return (response.body as Envelope<AnnouncementsSeen>).data as AnnouncementsSeen;
  }

  async function storedWatermark(): Promise<Date | null> {
    const row = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: clientId },
      select: { announcementsSeenAt: true },
    });
    return row.announcementsSeenAt;
  }

  describe('GET /me/announcements', () => {
    it('shows a new member the board as history: nothing new, count 0', async () => {
      await notice('Old one', new Date(Date.now() - 5 * DAY));
      await notice('Older one', new Date(Date.now() - 9 * DAY));
      await signUpClient();

      const body = await feed();

      expect(body.unreadCount).toBe(0);
      expect(body.items.map((item) => [item.title, item.isNew])).toEqual([
        ['Old one', false],
        ['Older one', false],
      ]);
      expect(await storedWatermark()).toBeNull();
    });

    it('counts a notice posted after signup as new', async () => {
      await notice('Before signup', new Date(Date.now() - 5 * DAY));
      await signUpClient();

      await request(server)
        .post('/api/v1/admin/announcements')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'After signup', content: 'Posted once they were a member.' })
        .expect(201);

      const body = await feed();

      expect(body.unreadCount).toBe(1);
      expect(body.items.map((item) => [item.title, item.isNew])).toEqual([
        ['After signup', true],
        ['Before signup', false],
      ]);
    });

    it('floors the watermark at 30 days for a long-standing member', async () => {
      await signUpClient();
      await ctx.prisma.user.update({
        where: { id: clientId },
        data: { createdAt: new Date(Date.now() - 400 * DAY) },
      });
      await notice('Forty days ago', new Date(Date.now() - 40 * DAY));
      await notice('Ten days ago', new Date(Date.now() - 10 * DAY));

      const body = await feed();

      expect(body.unreadCount).toBe(1);
      expect(body.items.map((item) => [item.title, item.isNew])).toEqual([
        ['Ten days ago', true],
        ['Forty days ago', false],
      ]);
    });

    it('lists items chronologically and carries pinned separately, newest first, at most five', async () => {
      await signUpClient();
      for (let i = 1; i <= 6; i += 1) {
        await notice(`Pinned ${i}`, new Date(Date.now() - (60 - i) * DAY), true);
      }
      await notice('Latest, not pinned', new Date(Date.now() - DAY));

      const body = await feed('?page=1&limit=3');

      // Chronological: the newest notice leads even though it is not pinned.
      expect(body.items.map((item) => item.title)).toEqual([
        'Latest, not pinned',
        'Pinned 6',
        'Pinned 5',
      ]);
      expect(body.total).toBe(7);
      expect(body.totalPages).toBe(3);
      expect(body.pinned.map((item) => item.title)).toEqual([
        'Pinned 6',
        'Pinned 5',
        'Pinned 4',
        'Pinned 3',
        'Pinned 2',
      ]);
      expect(body.pinned.every((item) => item.isPinned)).toBe(true);
    });

    it('401s without a token', async () => {
      await request(server).get('/api/v1/me/announcements').expect(401);
      await request(server)
        .post('/api/v1/me/announcements/seen')
        .send({ upTo: new Date().toISOString() })
        .expect(401);
    });
  });

  describe('POST /me/announcements/seen', () => {
    it('zeroes the count and moves the watermark to the notice shown', async () => {
      await signUpClient();
      const { createdAt } = await notice('New to them', new Date());
      expect((await feed()).unreadCount).toBe(1);

      const result = await seen(createdAt.toISOString());

      expect(result).toEqual({ seenAt: createdAt.toISOString(), unreadCount: 0 });
      expect(await storedWatermark()).toEqual(createdAt);
      const after = await feed();
      expect(after.unreadCount).toBe(0);
      expect(after.items[0]?.isNew).toBe(false);
    });

    it('never moves backwards when an older upTo arrives', async () => {
      await signUpClient();
      // After signup, so the first write lands (see the next test for why a
      // mark older than signup is not written at all).
      const newer = new Date();
      await seen(newer.toISOString());
      expect(await storedWatermark()).toEqual(newer);

      const result = await seen(new Date(Date.now() - 3 * DAY).toISOString());

      expect(result.seenAt).toBe(newer.toISOString());
      expect(await storedWatermark()).toEqual(newer);
    });

    it('does not rewind a never-opened member below their signup', async () => {
      await notice('Before signup', new Date(Date.now() - 5 * DAY));
      await signUpClient();

      const result = await seen(new Date(Date.now() - 5 * DAY).toISOString());

      // Effective watermark stays at createdAt; nothing was written.
      expect(result.unreadCount).toBe(0);
      expect(await storedWatermark()).toBeNull();
    });

    it('clamps a future upTo to now, so later notices still arrive as new', async () => {
      await signUpClient();
      const before = Date.now();

      const result = await seen('2099-01-01T00:00:00.000Z');

      const stored = (await storedWatermark()) as Date;
      expect(stored.getTime()).toBeGreaterThanOrEqual(before);
      expect(stored.getTime()).toBeLessThanOrEqual(Date.now());
      expect(new Date(result.seenAt).getFullYear()).toBeLessThan(2099);

      await request(server)
        .post('/api/v1/admin/announcements')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'Posted afterwards', content: 'Must not be pre-read.' })
        .expect(201);
      expect((await feed()).unreadCount).toBe(1);
    });

    it('400s on a body that is not a single ISO instant', async () => {
      await signUpClient();
      const post = () =>
        request(server)
          .post('/api/v1/me/announcements/seen')
          .set('Authorization', `Bearer ${clientToken}`);

      await post().send({}).expect(400);
      await post().send({ upTo: 'yesterday' }).expect(400);
      await post().send({ upTo: new Date().toISOString(), userId: clientId }).expect(400);
    });
  });

  describe('GET /announcements (unchanged)', () => {
    it('is still pinned-first for the admin list', async () => {
      await signUpClient();
      await notice('Old pinned', new Date(Date.now() - 30 * DAY), true);
      await notice('Fresh', new Date(Date.now() - DAY));

      const response = await request(server)
        .get('/api/v1/announcements')
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(200);

      const titles = (response.body as Envelope<{ items: { title: string }[] }>).data?.items.map(
        (item) => item.title,
      );
      expect(titles).toEqual(['Old pinned', 'Fresh']);
    });

    it('401s without a token', async () => {
      await request(server).get('/api/v1/announcements').expect(401);
    });
  });
});
