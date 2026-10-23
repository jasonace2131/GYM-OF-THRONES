import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';
import { makeMember, seedPlansForTest } from './support/membership-fixtures';
import { GymConfigService } from '../src/config/gym.config';
import { gymToday } from '../src/common/time/gym-time';

/**
 * Member-only features need an ACTIVE membership (owner, 2026-10-17): the
 * writes are refused with 403 MEMBERSHIP_REQUIRED, the reads stay open so an
 * expired member keeps their history, and staff are never asked.
 *
 * Guards run before pipes and interceptors, so the refusal arrives before any
 * body validation or Idempotency-Key handling — no AI is spent and no row is
 * written.
 */
describe('Membership gate on member-only features (e2e)', () => {
  let ctx: TestApp;
  let server: Server;

  const SUPABASE = {
    NONE: '20000000-0000-4000-8000-000000000001',
    EXPIRED: '20000000-0000-4000-8000-000000000002',
    GRACE: '20000000-0000-4000-8000-000000000003',
    ACTIVE: '20000000-0000-4000-8000-000000000004',
  } as const;
  const tokens: Record<keyof typeof SUPABASE, string> = {
    NONE: '',
    EXPIRED: '',
    GRACE: '',
    ACTIVE: '',
  };

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const idem = () => ({ 'Idempotency-Key': randomUUID() });
  const startWorkout = (token: string) =>
    request(server)
      .post('/api/v1/me/workouts/sessions')
      .set(as(token))
      .set(idem())
      .send({ source: 'COACH', weekday: 'MON' });

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
    await resetDatabase(ctx.prisma);
    await seedPlansForTest(ctx.prisma);
    const today = gymToday(new Date(), ctx.app.get(GymConfigService, { strict: false }).timeZone);

    for (const key of Object.keys(SUPABASE) as (keyof typeof SUPABASE)[]) {
      tokens[key] = await ctx.fixture.tokenFor('CLIENT', { supabaseId: SUPABASE[key] });
    }
    const id = (key: keyof typeof SUPABASE) => ctx.fixture.userIdFor(SUPABASE[key]);
    await makeMember(ctx.prisma, {
      state: 'EXPIRED_PAST_GRACE',
      today,
      userId: await id('EXPIRED'),
    });
    await makeMember(ctx.prisma, { state: 'IN_GRACE', today, userId: await id('GRACE') });
    await makeMember(ctx.prisma, { state: 'ACTIVE', today, userId: await id('ACTIVE') });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it.each([['NONE'], ['EXPIRED'], ['GRACE']] as const)(
    'refuses a %s member a write with 403 MEMBERSHIP_REQUIRED',
    async (key) => {
      const res = await startWorkout(tokens[key]).expect(403);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'MEMBERSHIP_REQUIRED', message: 'This needs an active membership.' },
      });
    },
  );

  it('lets an active member past the gate (whatever the feature then says)', async () => {
    const res = await startWorkout(tokens.ACTIVE);
    expect(res.status).not.toBe(403);
  });

  it('tells the portal through GET /me: LOCKED, READ_ONLY or FULL', async () => {
    const access = async (token: string): Promise<unknown> =>
      (
        (await request(server).get('/api/v1/me').set(as(token)).expect(200)).body as {
          data: { memberAccess: unknown };
        }
      ).data.memberAccess;
    expect(await access(tokens.NONE)).toBe('LOCKED');
    expect(await access(tokens.EXPIRED)).toBe('READ_ONLY');
    expect(await access(tokens.GRACE)).toBe('READ_ONLY');
    expect(await access(tokens.ACTIVE)).toBe('FULL');
  });

  it('keeps the reads open for an expired member', async () => {
    await request(server).get('/api/v1/me/workouts').set(as(tokens.EXPIRED)).expect(200);
    await request(server).get('/api/v1/me/workouts/sessions').set(as(tokens.EXPIRED)).expect(200);
    await request(server).get('/api/v1/me/progress').set(as(tokens.EXPIRED)).expect(200);
    await request(server).get('/api/v1/me/coach').set(as(tokens.EXPIRED)).expect(200);
  });
});
