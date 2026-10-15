/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access --
   supertest types res.body as `any`; every e2e spec reads assertions off it. */
import request from 'supertest';
import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

/**
 * Proves the harness itself, not a feature.
 *
 * If this file is red, nothing else in test/ can be trusted: it asserts that
 * the scratch database was migrated AND seeded, that fixture tokens verify
 * in-process with no network call, and that the global pipeline (prefix,
 * versioning, envelope, guards) is the same one main.ts builds.
 */
describe('harness + health (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ throttling: 'on' });
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('serves /api/health with no token and no version segment', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/health').expect(200);

    expect(res.body).toEqual({
      success: true,
      data: {
        status: 'ok',
        timestamp: expect.any(String),
        uptime: expect.any(Number),
      },
    });
  });

  it('does not throttle the health probe — @SkipThrottle is real', async () => {
    // The global limit is 100/60s. A probe every 10 seconds would eat it.
    for (let i = 0; i < 120; i += 1) {
      await request(ctx.app.getHttpServer()).get('/api/health').expect(200);
    }
  });

  it('rejects /api/v1/me with no Authorization header', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/me').expect(401);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('HTTP_401');
  });

  it('returns the fixture ADMIN its own profile with a non-empty permission set', async () => {
    const token = await ctx.fixture.tokenFor('ADMIN');

    const res = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.data.role).toBe('ADMIN');
    expect(res.body.data.email).toContain('@fixture.test');
    // Non-empty is the proof `prisma db seed` ran. A skipped seed fails closed
    // and silently: every non-DEV role resolves zero permissions.
    expect(res.body.data.permissions.length).toBeGreaterThan(0);
    expect(res.body.data.permissions).toContainEqual({ key: 'permission.read', scope: 'ALL' });
  });

  it('lets the seeded ADMIN through a permission-gated route', async () => {
    const token = await ctx.fixture.tokenFor('ADMIN');

    await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/permissions')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('403s a role that does not hold the required permission', async () => {
    const token = await ctx.fixture.tokenFor('CLIENT');

    const res = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/permissions')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(res.body.error.code).toBe('HTTP_403');
  });

  it('mints distinct users for distinct fixture supabaseIds at the same role', async () => {
    const coachA = '20000000-0000-4000-8000-00000000000a';
    const coachB = '20000000-0000-4000-8000-00000000000b';

    await ctx.fixture.tokenFor('COACH', { supabaseId: coachA });
    await ctx.fixture.tokenFor('COACH', { supabaseId: coachB });

    const idA = await ctx.fixture.userIdFor(coachA);
    const idB = await ctx.fixture.userIdFor(coachB);

    expect(idA).not.toEqual(idB);
  });
});
