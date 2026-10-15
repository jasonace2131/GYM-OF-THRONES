import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';

// 101 sequential authenticated requests against a real database. Slow on
// purpose — this is the only suite that opts throttling back on.
jest.setTimeout(300_000);

const GLOBAL_LIMIT = 100;

describe('throttling (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    ctx = await createTestApp({ throttling: 'on' });
    server = ctx.app.getHttpServer() as Server;
    await resetDatabase(ctx.prisma);
    userA = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
    userB = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_B });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('throttles one user without throttling the other on the same IP, and sends a readable Retry-After', async () => {
    let throttled: request.Response | null = null;

    for (let i = 0; i < GLOBAL_LIMIT + 5 && throttled === null; i += 1) {
      const res = await request(server).get('/api/v1/me').set('Authorization', `Bearer ${userA}`);
      if (res.status === 429) throttled = res;
    }

    expect(throttled).not.toBeNull();
    // Both requests leave the same socket, so the default IP tracker would
    // have taken the whole building down with one member. This assertion is
    // the reason UserThrottlerGuard exists.
    expect(throttled?.headers['retry-after']).toMatch(/^\d+$/);

    await request(server).get('/api/v1/me').set('Authorization', `Bearer ${userB}`).expect(200);
  });

  it('does not throttle the health probe', async () => {
    // Must exceed GLOBAL_LIMIT to be a meaningful assertion — anything at or
    // under the limit would pass whether or not @SkipThrottle() is present,
    // which is the bug this test used to have.
    for (let i = 0; i < GLOBAL_LIMIT + 5; i += 1) {
      await request(server).get('/api/health').expect(200);
    }
  });
});
