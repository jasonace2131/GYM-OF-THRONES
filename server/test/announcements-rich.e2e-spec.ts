import request from 'supertest';
import type { Server } from 'http';
import type { Announcement, AnnouncementUploadStatus, MemberAnnouncementFeed } from '@got/shared';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { AnnouncementImageStorageService } from '../src/storage/announcement-image-storage.service';

jest.setTimeout(120_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/**
 * Rich-text announcements through the real pipeline: DTO, allowlist, derived
 * plain text, the member feed, the audit trail and the upload routes.
 *
 * The image base comes from the same SUPABASE_URL the app booted with, so the
 * "our bucket" image below is exactly what the server itself would mint. No
 * test here signs a real upload — that would talk to real storage.
 */
describe('rich announcements (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let adminToken: string;
  let clientToken: string;
  let base: string;
  let ourImage: string;

  const doc = (...content: unknown[]): Record<string, unknown> => ({ type: 'doc', content });
  const para = (text: string, marks?: unknown[]): Record<string, unknown> => ({
    type: 'paragraph',
    content: [{ type: 'text', text, ...(marks === undefined ? {} : { marks }) }],
  });
  const link = (href: string): unknown[] => [{ type: 'link', attrs: { href } }];

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
    // The base the booted app validates against, not a re-derivation of it.
    base = ctx.app.get(AnnouncementImageStorageService, { strict: false }).publicBaseUrl;
    ourImage = `${base}announcements/0b6a3c4e-5d2f-4a1b-8c9d-0e1f2a3b4c5d.webp`;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    clientToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
  });

  const post = (body: Record<string, unknown>) =>
    request(server)
      .post('/api/v1/admin/announcements')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);

  const patch = (id: string, body: Record<string, unknown>) =>
    request(server)
      .patch(`/api/v1/admin/announcements/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);

  const auditActions = async (): Promise<string[]> =>
    (
      await ctx.prisma.auditLog.findMany({
        where: { subjectType: 'Announcement' },
        orderBy: { occurredAt: 'asc' },
        select: { action: true },
      })
    ).map((row) => row.action);

  describe('composing', () => {
    it('stores a rich notice with an image and a link, and derives the plain text', async () => {
      const response = await post({
        title: 'Holiday hours',
        contentJson: doc(
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'This week' }] },
          para('Details here', link('https://gymofthrones.ph/hours')),
          { type: 'image', attrs: { src: ourImage, alt: 'The floor' } },
        ),
        coverImageUrl: ourImage,
      }).expect(201);

      const notice = (response.body as Envelope<Announcement>).data as Announcement;
      expect(notice.content).toBe('This week\n\nDetails here');
      expect(notice.contentJson?.content).toHaveLength(3);
      expect(notice.coverImageUrl).toBe(ourImage);

      const row = await ctx.prisma.announcement.findUniqueOrThrow({ where: { id: notice.id } });
      expect(row.content).toBe('This week\n\nDetails here');
      expect(row.contentJson).not.toBeNull();
    });

    it('strips attributes nobody allowed, rather than storing them', async () => {
      const response = await post({
        title: 'x',
        contentJson: doc({
          type: 'paragraph',
          attrs: { style: 'position:fixed', onclick: 'alert(1)' },
          content: [{ type: 'text', text: 'hello' }],
        }),
      }).expect(201);

      const notice = (response.body as Envelope<Announcement>).data as Announcement;
      expect(notice.contentJson).toEqual(doc(para('hello')));
    });

    // Factories, not values: `it.each` rows are built before `beforeAll` has
    // read the bucket base from the booted app.
    it.each([
      ['a javascript: link', () => doc(para('click', link('javascript:alert(document.cookie)')))],
      ['a data: link', () => doc(para('click', link('data:text/html,<script>alert(1)</script>')))],
      [
        'a hotlinked image',
        () => doc(para('x'), { type: 'image', attrs: { src: 'https://evil.example/cat.png' } }),
      ],
      [
        'an SVG image in our bucket',
        () =>
          doc(para('x'), {
            type: 'image',
            attrs: { src: ourImage.replace(/\.webp$/, '.svg') },
          }),
      ],
      ['an unknown node', () => doc(para('x'), { type: 'iframe', attrs: { src: 'https://evil' } })],
      ['an unknown mark', () => doc(para('x', [{ type: 'textStyle', attrs: { color: 'red' } }]))],
      ['no text at all', () => doc({ type: 'paragraph' })],
    ])('refuses %s with a 400 and stores nothing', async (_label, make) => {
      const response = await post({ title: 'x', contentJson: make() }).expect(400);
      expect((response.body as Envelope<never>).error?.code).toBe('ANNOUNCEMENT_CONTENT_INVALID');
      expect(await ctx.prisma.announcement.count()).toBe(0);
    });

    it('refuses a depth bomb with a 400, not a 500', async () => {
      let node: Record<string, unknown> = para('deep');
      for (let i = 0; i < 200; i += 1) node = { type: 'blockquote', content: [node] };
      const response = await post({ title: 'x', contentJson: doc(node) }).expect(400);
      expect((response.body as Envelope<never>).error?.message).toMatch(/nested/i);
    });

    it('refuses a cover image from elsewhere', async () => {
      await post({ title: 'x', content: 'y', coverImageUrl: 'https://evil.example/x.jpg' }).expect(
        400,
      );
    });

    it('refuses both content and contentJson', async () => {
      await post({ title: 'x', content: 'plain', contentJson: doc(para('rich')) }).expect(400);
    });
  });

  describe('old plain notices', () => {
    it('still post and read exactly as before, with contentJson null', async () => {
      const response = await post({ title: 'Plain', content: 'Just text.' }).expect(201);
      const notice = (response.body as Envelope<Announcement>).data as Announcement;
      expect(notice.content).toBe('Just text.');
      expect(notice.contentJson).toBeNull();
      expect(notice.coverImageUrl).toBeNull();
    });

    it('reach the member feed alongside rich ones', async () => {
      await post({ title: 'Plain', content: 'Just text.' }).expect(201);
      await post({ title: 'Rich', contentJson: doc(para('Bold news')) }).expect(201);

      const response = await request(server)
        .get('/api/v1/me/announcements')
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(200);
      const feed = (response.body as Envelope<MemberAnnouncementFeed>)
        .data as MemberAnnouncementFeed;

      const byTitle = new Map(feed.items.map((item) => [item.title, item]));
      expect(byTitle.get('Plain')?.contentJson).toBeNull();
      expect(byTitle.get('Rich')?.contentJson).toEqual(doc(para('Bold news')));
      expect(byTitle.get('Rich')?.content).toBe('Bold news');
    });
  });

  describe('audit', () => {
    it('records create, edit, pin and delete — and nothing for a no-op edit', async () => {
      const created = await post({ title: 'Hours', content: 'Open late.' }).expect(201);
      const id = ((created.body as Envelope<Announcement>).data as Announcement).id;

      await patch(id, { contentJson: doc(para('Open later.')) }).expect(200);
      await patch(id, { isPinned: true }).expect(200);
      await patch(id, { isPinned: true }).expect(200); // no change → no entry
      await request(server)
        .delete(`/api/v1/admin/announcements/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(await auditActions()).toEqual([
        'ANNOUNCEMENT_CREATED',
        'ANNOUNCEMENT_UPDATED',
        'ANNOUNCEMENT_UPDATED',
        'ANNOUNCEMENT_DELETED',
      ]);

      const pin = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'ANNOUNCEMENT_UPDATED', subjectId: id },
        orderBy: { occurredAt: 'desc' },
      });
      expect(pin.details).toEqual({
        fields: ['isPinned'],
        isPinned: { before: false, after: true },
      });
      expect(pin.subjectLabel).toBe('Hours');
    });
  });

  describe('uploads', () => {
    it('tells an admin whether images are available', async () => {
      const response = await request(server)
        .get('/api/v1/admin/announcements/uploads')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const status = (response.body as Envelope<AnnouncementUploadStatus>).data;
      expect(typeof status?.enabled).toBe('boolean');
    });

    it('refuses a member — announcement.create only', async () => {
      await request(server)
        .post('/api/v1/admin/announcements/uploads')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ contentType: 'image/webp', size: 1000 })
        .expect(403);
    });

    it.each([
      ['an SVG', { contentType: 'image/svg+xml', size: 1000 }],
      ['a 6 MB image', { contentType: 'image/webp', size: 6 * 1024 * 1024 }],
      ['a caller-chosen path', { contentType: 'image/webp', size: 1000, path: '../x.webp' }],
    ])('refuses %s with a 400', async (_label, body) => {
      await request(server)
        .post('/api/v1/admin/announcements/uploads')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body)
        .expect(400);
    });
  });
});
