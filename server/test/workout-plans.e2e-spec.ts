import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { GeminiGateway } from '../src/assistant/gemini-gateway.service';

jest.setTimeout(120_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: { errors?: string[] } };
}

const PLAN = {
  summary: 'Three full-body days to build a base.',
  days: [
    {
      day: 'Monday',
      focus: 'Lower body',
      exercises: [
        { name: 'Goblet squat', sets: 3, reps: '8-10' },
        { name: 'Plank', sets: 3, reps: '30s', notes: 'Brace hard' },
      ],
    },
  ],
};

/**
 * Workout plans, end to end (feat/coach-tools): suggest → edit → save by the
 * assigned coach, then the member reads it.
 *
 * GEMINI IS STUBBED at `GeminiGateway.rotate`. The e2e harness reads its env
 * from server/.env, and a real GEMINI_API_KEY there must never spend the
 * gym's shared free quota on a test run. Everything else — the scope, the
 * context read, the reply's validation, the save, the audit — is real.
 */
describe('workout plans (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let rotate: jest.SpyInstance;

  let adminToken: string;
  let coachAToken: string;
  let coachBToken: string;
  let clientAToken: string;
  let clientBToken: string;

  let coachAId: string;
  let clientAId: string;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const planPath = (memberId: string, rest = ''): string =>
    `/api/v1/me/coaching/members/${memberId}/workout-plan${rest}`;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
    await resetDatabase(ctx.prisma);

    const gateway = ctx.app.get(GeminiGateway, { strict: false });
    jest.spyOn(gateway, 'assertEnabled').mockImplementation(() => undefined);
    rotate = jest.spyOn(gateway, 'rotate').mockResolvedValue({
      model: 'stub-model',
      value: { text: JSON.stringify(PLAN), finish: 'STOP' },
      attempts: 1,
      startedAt: Date.now(),
    });

    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    coachAToken = await ctx.fixture.tokenFor('COACH', {
      supabaseId: FIXTURE_IDS.COACH_A,
      firstName: 'Ana',
      lastName: 'Reyes',
    });
    coachBToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_B });
    clientAToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
    clientBToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_B });

    coachAId = await ctx.fixture.userIdFor(FIXTURE_IDS.COACH_A);
    clientAId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);

    await request(server)
      .post('/api/v1/coach-assignments')
      .set(as(adminToken))
      .send({ coachId: coachAId, memberId: clientAId })
      .expect(201);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ctx.close();
  });

  it('starts with no plan, for the coach and for the member', async () => {
    const coach = await request(server).get(planPath(clientAId)).set(as(coachAToken)).expect(200);
    expect((coach.body as Envelope<{ plan: unknown }>).data).toEqual({ plan: null });

    const mine = await request(server)
      .get('/api/v1/me/workout-plan')
      .set(as(clientAToken))
      .expect(200);
    expect((mine.body as Envelope<{ plan: unknown }>).data).toEqual({ plan: null });
  });

  it('suggests a validated DRAFT and saves nothing', async () => {
    const res = await request(server)
      .post(planPath(clientAId, '/suggest'))
      .set(as(coachAToken))
      .expect(201);
    expect((res.body as Envelope<{ draft: unknown }>).data).toEqual({ draft: PLAN });
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(await ctx.prisma.workoutPlan.count()).toBe(0);
  });

  it('refuses a model reply that is not a plan with WORKOUT_PLAN_SUGGESTION_INVALID', async () => {
    rotate.mockResolvedValueOnce({
      model: 'stub-model',
      value: { text: 'Here is a plan: squats on Monday', finish: 'STOP' },
      attempts: 1,
      startedAt: Date.now(),
    });
    const res = await request(server)
      .post(planPath(clientAId, '/suggest'))
      .set(as(coachAToken))
      .expect(502);
    expect((res.body as Envelope<never>).error?.code).toBe('WORKOUT_PLAN_SUGGESTION_INVALID');
  });

  it('refuses an invalid save with WORKOUT_PLAN_INVALID and names the field', async () => {
    const res = await request(server)
      .put(planPath(clientAId))
      .set(as(coachAToken))
      .send({
        summary: 'x',
        days: [{ day: 'Mon', focus: 'Legs', exercises: [{ name: 'Squat', sets: 0, reps: '5' }] }],
      })
      .expect(422);
    expect((res.body as Envelope<never>).error?.code).toBe('WORKOUT_PLAN_INVALID');

    // An unknown top-level field is refused by the pipe before the schema.
    await request(server)
      .put(planPath(clientAId))
      .set(as(coachAToken))
      .send({ ...PLAN, memberId: clientAId })
      .expect(400);
  });

  it('saves the edited plan, audits counts only, and the member reads it', async () => {
    const edited = { ...PLAN, summary: 'Edited by the coach.' };
    const res = await request(server)
      .put(planPath(clientAId))
      .set(as(coachAToken))
      .send(edited)
      .expect(200);
    expect((res.body as Envelope<{ plan: unknown }>).data).toMatchObject({
      plan: edited,
      coach: { firstName: 'Ana', lastName: 'Reyes' },
    });

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'WORKOUT_PLAN_SAVED' },
    });
    expect(audit.details).toEqual({ memberId: clientAId, created: true, days: 1, exercises: 2 });

    const mine = await request(server)
      .get('/api/v1/me/workout-plan')
      .set(as(clientAToken))
      .expect(200);
    expect((mine.body as Envelope<{ plan: { plan: unknown } }>).data?.plan.plan).toEqual(edited);

    // Saving again replaces the one plan.
    await request(server).put(planPath(clientAId)).set(as(coachAToken)).send(PLAN).expect(200);
    expect(await ctx.prisma.workoutPlan.count({ where: { memberId: clientAId } })).toBe(1);
  });

  it('answers 404 for a member the coach does not coach — and for the coach themselves', async () => {
    await request(server).get(planPath(clientAId)).set(as(coachBToken)).expect(404);
    await request(server).put(planPath(clientAId)).set(as(coachBToken)).send(PLAN).expect(404);
    await request(server).post(planPath(clientAId, '/suggest')).set(as(coachBToken)).expect(404);
    await request(server).get(planPath(coachAId)).set(as(coachAToken)).expect(404);
  });

  it('keeps members and admins off the coach routes, and coaches off the member route', async () => {
    await request(server).get(planPath(clientAId)).set(as(clientBToken)).expect(403);
    await request(server).post(planPath(clientAId, '/suggest')).set(as(adminToken)).expect(403);
    await request(server).get('/api/v1/me/workout-plan').set(as(coachAToken)).expect(403);
  });
});
