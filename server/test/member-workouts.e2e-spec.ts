import { randomUUID } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'http';
import type {
  MemberWorkoutPlanView,
  SwapResponse,
  WorkoutAiQuotaView,
  WorkoutDraftView,
  WorkoutsHome,
} from '@got/shared';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { makeActiveMembers } from './support/membership-fixtures';
import { GymConfigService } from '../src/config/gym.config';
import { gymToday } from '../src/common/time/gym-time';
import { GeminiGateway, type AttemptContext } from '../src/assistant/gemini-gateway.service';
import { DomainException } from '../src/common/exceptions/domain.exception';
import { MEMBER_COPY } from '../src/workouts/member-workout-gemini';

jest.setTimeout(120_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: { errors?: string[] } };
}

const INTAKE = {
  goal: 'MUSCLE',
  goalNotes: 'Bigger arms',
  experience: 'SOME',
  weekdays: [1, 3],
  sessionMinutes: 45,
  timeOfDay: 'EVENING',
  healthFlag: false,
  easyOn: ['KNEES'],
  use: { measurements: true, attendance: true, bookings: true },
  consent: true,
};

const exercise = (name: string) => ({
  name,
  muscles: 'Legs · glutes',
  sets: 3,
  reps: '8-12',
  restSeconds: 90,
});

const day = (weekday: number) => ({
  weekday,
  title: `Day ${weekday}`,
  focus: 'Full body',
  minutes: 45,
  warmUp: '5 min easy bike',
  coolDown: '3 min walk',
  exercises: [exercise('Goblet squat'), exercise('Plank')],
});

const GUIDANCE = [
  { title: 'Sleep', body: '7-9 hours.' },
  { title: 'Water', body: 'Drink before and after.' },
];

const GOOD_LINES = [
  '{"summary":"Two full-body days to build a base."}',
  `{"day":${JSON.stringify(day(1))}}`,
  `{"day":${JSON.stringify(day(3))}}`,
  `{"guidance":${JSON.stringify(GUIDANCE)}}`,
];

const GUIDE = {
  steps: ['Hold the bell at your chest.', 'Sit between your heels.', 'Stand tall.'],
  mistake: 'Heels lifting — sit back more.',
  easier: 'Squat to a box.',
  harder: 'Pause two seconds at the bottom.',
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The member workout planner, end to end (feat/member-workouts): generate →
 * poll → save → library rules → the two paid tools → guides → cancel → stale.
 *
 * GEMINI IS STUBBED at `GeminiGateway.rotate`, but the stub RUNS the caller's
 * own attempt against a fake SDK client — so the real NDJSON streaming, the
 * line-by-line writes, the schema validation and the structured-reply
 * parsing all execute. A real GEMINI_API_KEY in server/.env must never spend
 * the gym's shared free quota on a test run. Everything else — permission,
 * quota, the draft row, the library, idempotency — is real.
 */
describe('member workouts (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let rotate: jest.SpyInstance;

  let clientAToken: string;
  let clientBToken: string;
  let coachToken: string;
  let adminToken: string;
  let clientAId: string;

  /** What the fake model streams (drafts) or answers (swap/adjust/guides) next. */
  const script: { lines: string[]; json: unknown; gate: Promise<void> | null } = {
    lines: GOOD_LINES,
    json: null,
    gate: null,
  };

  const fakeContext = (): AttemptContext =>
    ({
      client: {
        getGenerativeModel: () => ({
          generateContentStream: (): Promise<unknown> =>
            Promise.resolve({
              stream: (async function* () {
                let index = 0;
                for (const line of script.lines) {
                  // Hold the stream after the first day so a test can observe RUNNING.
                  if (index === 2 && script.gate !== null) await script.gate;
                  index += 1;
                  yield { text: () => `${line}\n` };
                }
              })(),
              response: Promise.resolve(null),
            }),
          generateContent: (): Promise<unknown> =>
            Promise.resolve({
              response: {
                text: () => JSON.stringify(script.json),
                candidates: [{ finishReason: 'STOP' }],
              },
            }),
        }),
      },
      deadline: Date.now() + 40_000,
      countRequest: () => undefined,
    }) as unknown as AttemptContext;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const idem = () => ({ 'Idempotency-Key': randomUUID() });
  const base = '/api/v1/me/workouts';

  const home = async (token: string): Promise<WorkoutsHome> => {
    const res = await request(server).get(base).set(as(token)).expect(200);
    return (res.body as Envelope<WorkoutsHome>).data!;
  };

  const quotaRow = async (): Promise<number | null> => {
    const rows = await ctx.prisma.workoutAiQuota.findMany({ where: { memberId: clientAId } });
    return rows.length === 0 ? null : rows.reduce((sum, row) => sum + row.used, 0);
  };

  /** Poll the draft until `until` holds (or it 404s), like the portal does. */
  const waitForDraft = async (
    token: string,
    until: (draft: WorkoutDraftView) => boolean,
    timeoutMs = 15_000,
  ): Promise<request.Response> => {
    const startedAt = Date.now();
    for (;;) {
      const res = await request(server).get(`${base}/draft`).set(as(token));
      const draft = (res.body as Envelope<WorkoutDraftView>).data;
      if (res.status !== 200 || (draft !== undefined && until(draft))) return res;
      if (Date.now() - startedAt > timeoutMs) throw new Error('draft did not settle in time');
      await sleep(100);
    }
  };

  const generate = async (token: string): Promise<WorkoutDraftView> => {
    await request(server)
      .post(`${base}/drafts`)
      .set(as(token))
      .set(idem())
      .send(INTAKE)
      .expect(202);
    const res = await waitForDraft(token, (d) => d.status !== 'RUNNING');
    return (res.body as Envelope<WorkoutDraftView>).data!;
  };

  const savePlan = async (
    token: string,
    name: string,
    makeActive = false,
  ): Promise<MemberWorkoutPlanView> => {
    const res = await request(server)
      .post(`${base}/plans`)
      .set(as(token))
      .set(idem())
      .send({ name, makeActive })
      .expect(201);
    return (res.body as Envelope<MemberWorkoutPlanView>).data!;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
    await resetDatabase(ctx.prisma);

    const gateway = ctx.app.get(GeminiGateway, { strict: false });
    jest.spyOn(gateway, 'assertEnabled').mockImplementation(() => undefined);
    rotate = jest
      .spyOn(gateway, 'rotate')
      .mockImplementation(
        async (
          _label: string,
          _copy: unknown,
          _budget: number,
          attempt: (model: string, context: AttemptContext) => Promise<unknown>,
        ) => ({
          model: 'stub-model',
          value: await attempt('stub-model', fakeContext()),
          attempts: 1,
          startedAt: Date.now(),
        }),
      );

    clientAToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
    clientBToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_B });
    coachToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    clientAId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);

    // The planner's writes need an ACTIVE membership (owner, 2026-10-17).
    await makeActiveMembers(
      ctx.prisma,
      [clientAId, await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_B)],
      gymToday(new Date(), ctx.app.get(GymConfigService, { strict: false }).timeZone),
    );
  });

  beforeEach(() => {
    script.lines = GOOD_LINES;
    script.json = null;
    script.gate = null;
    rotate.mockClear();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ctx.close();
  });

  describe('access', () => {
    it('is a CLIENT surface: staff without workout.member get 403', async () => {
      await request(server).get(base).set(as(coachToken)).expect(403);
      await request(server).get(base).set(as(adminToken)).expect(403);
      await request(server).get(base).expect(401);
    });

    it('starts empty for a member', async () => {
      expect(await home(clientAToken)).toEqual({
        plans: [],
        draft: null,
        quota: { used: 0, limit: 8, remaining: 8, resetsAt: expect.any(String) as string },
        lastIntake: null,
        // feat/workout-sessions: no coach plan, no open workout, no history.
        coachPlan: null,
        session: null,
        recent: [],
      });
    });
  });

  describe('generate', () => {
    it('needs an Idempotency-Key on every POST', async () => {
      await request(server).post(`${base}/drafts`).set(as(clientAToken)).send(INTAKE).expect(400);
    });

    it('refuses without consent, with the member copy, before charging', async () => {
      const res = await request(server)
        .post(`${base}/drafts`)
        .set(as(clientAToken))
        .set(idem())
        .send({ ...INTAKE, consent: false })
        .expect(400);
      expect((res.body as Envelope<never>).error).toMatchObject({
        code: 'WORKOUT_CONSENT_REQUIRED',
      });
      expect(await quotaRow()).toBeNull();
    });

    it('rejects an unknown field and a bad weekday at the pipe', async () => {
      await request(server)
        .post(`${base}/drafts`)
        .set(as(clientAToken))
        .set(idem())
        .send({ ...INTAKE, parq: [true] })
        .expect(400);
      await request(server)
        .post(`${base}/drafts`)
        .set(as(clientAToken))
        .set(idem())
        .send({ ...INTAKE, weekdays: [7] })
        .expect(400);
    });

    it('charges one action, answers 202 RUNNING, then streams Day 1 before the rest and lands READY', async () => {
      let release: () => void = () => undefined;
      script.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const started = await request(server)
        .post(`${base}/drafts`)
        .set(as(clientAToken))
        .set(idem())
        .send(INTAKE)
        .expect(202);
      const { draft, quota } = (
        started.body as Envelope<{ draft: WorkoutDraftView; quota: WorkoutAiQuotaView }>
      ).data!;
      expect(draft).toMatchObject({ status: 'RUNNING', error: null, firstDayMs: null });
      expect(draft.intake).toEqual({ ...INTAKE, consent: undefined });
      expect(quota).toMatchObject({ used: 1, remaining: 7 });

      // Day 1 arrives while the model is still writing.
      const partial = await waitForDraft(clientAToken, (d) => d.plan.days.length === 1);
      const running = (partial.body as Envelope<WorkoutDraftView>).data!;
      expect(running.status).toBe('RUNNING');
      expect(running.plan.summary).toBe('Two full-body days to build a base.');
      expect(running.plan.days[0].weekday).toBe(1);
      expect(running.plan.guidance).toBeNull();
      expect(running.firstDayMs).toEqual(expect.any(Number));
      expect(running.firstDayMs).toBeGreaterThanOrEqual(0);

      // A second generation while one runs is a 409, and costs nothing.
      const again = await request(server)
        .post(`${base}/drafts`)
        .set(as(clientAToken))
        .set(idem())
        .send(INTAKE)
        .expect(409);
      expect((again.body as Envelope<never>).error?.code).toBe('WORKOUT_DRAFT_RUNNING');
      expect(await quotaRow()).toBe(1);

      release();
      const done = await waitForDraft(clientAToken, (d) => d.status !== 'RUNNING');
      const ready = (done.body as Envelope<WorkoutDraftView>).data!;
      expect(ready.status).toBe('READY');
      expect(ready.plan.days.map((d) => d.weekday)).toEqual([1, 3]);
      expect(ready.plan.guidance).toEqual(GUIDANCE);
      expect((await home(clientAToken)).draft?.status).toBe('READY');
    });

    it('fails with member copy and refunds when every model writes something unusable', async () => {
      await request(server).delete(`${base}/draft`).set(as(clientAToken)).expect(200);
      const before = (await quotaRow()) ?? 0;
      script.lines = ['{"summary":"x"}', 'Here is your plan: squats on Monday'];
      rotate.mockImplementationOnce(
        async (
          _label: string,
          _copy: unknown,
          _budget: number,
          attempt: (model: string, context: AttemptContext) => Promise<unknown>,
        ) => {
          // The real gateway's shape of an exhausted rotation.
          await attempt('stub-model', fakeContext()).catch(() => undefined);
          throw new DomainException(
            'ASSISTANT_BUSY',
            'The AI is busy right now. Try again in a minute.',
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        },
      );

      const failed = await generate(clientAToken);

      expect(failed.status).toBe('FAILED');
      // The last attempt was an unusable reply, so the member hears that, not "busy".
      expect(failed.error).toBe(MEMBER_COPY.unusable);
      expect(await quotaRow()).toBe(before);
    });

    it('fails a stale RUNNING draft on the next read and refunds it', async () => {
      await request(server).delete(`${base}/draft`).set(as(clientAToken)).expect(200);
      const before = (await quotaRow()) ?? 0;
      await ctx.prisma.workoutAiQuota.updateMany({
        where: { memberId: clientAId },
        data: { used: before + 1 },
      });
      await ctx.prisma.memberWorkoutDraft.create({
        data: {
          memberId: clientAId,
          jobId: randomUUID(),
          status: 'RUNNING',
          intake: { ...INTAKE, consent: undefined },
          plan: { summary: null, days: [], guidance: null },
          consentAt: new Date(),
          startedAt: new Date(Date.now() - 2 * 60_000),
        },
      });

      const res = await request(server).get(`${base}/draft`).set(as(clientAToken)).expect(200);
      expect((res.body as Envelope<WorkoutDraftView>).data).toMatchObject({
        status: 'FAILED',
        error: 'It took too long. Try again.',
      });
      expect((await quotaRow()) ?? 0).toBe(before);
    });

    it('cancels: the row is gone, no refund, and the poll 404s', async () => {
      await ctx.prisma.workoutAiQuota.deleteMany({ where: { memberId: clientAId } });
      await request(server)
        .post(`${base}/drafts`)
        .set(as(clientAToken))
        .set(idem())
        .send(INTAKE)
        .expect(202);
      const res = await request(server).delete(`${base}/draft`).set(as(clientAToken)).expect(200);
      expect((res.body as Envelope<{ cancelled: boolean }>).data).toEqual({ cancelled: true });

      const gone = await request(server).get(`${base}/draft`).set(as(clientAToken)).expect(404);
      expect((gone.body as Envelope<never>).error?.code).toBe('WORKOUT_DRAFT_MISSING');
      // Let the orphaned job finish: its writes match nothing.
      await sleep(300);
      expect(await ctx.prisma.memberWorkoutDraft.count({ where: { memberId: clientAId } })).toBe(0);
      expect(await quotaRow()).toBe(1);
    });
  });

  describe('library', () => {
    let planA: MemberWorkoutPlanView;

    beforeAll(async () => {
      await ctx.prisma.workoutAiQuota.deleteMany({ where: { memberId: clientAId } });
      await ctx.prisma.memberWorkoutDraft.deleteMany({ where: { memberId: clientAId } });
    });

    it('saving without a draft is 404 WORKOUT_DRAFT_MISSING', async () => {
      const res = await request(server)
        .post(`${base}/plans`)
        .set(as(clientAToken))
        .set(idem())
        .send({ name: 'A', makeActive: true })
        .expect(404);
      expect((res.body as Envelope<never>).error?.code).toBe('WORKOUT_DRAFT_MISSING');
    });

    it('saves the READY draft as the active plan and deletes the draft', async () => {
      await generate(clientAToken);
      planA = await savePlan(clientAToken, '  Push pull ', true);

      // The stored intake is everything but the consent literal (WorkoutIntakeSummary).
      const intakeSummary = Object.fromEntries(
        Object.entries(INTAKE).filter(([key]) => key !== 'consent'),
      );
      expect(planA).toMatchObject({
        name: 'Push pull',
        isActive: true,
        source: 'AI',
        intake: intakeSummary,
      });
      expect('consent' in planA.intake).toBe(false);
      expect(planA.plan.days.map((d) => d.weekday)).toEqual([1, 3]);

      await request(server).get(`${base}/draft`).set(as(clientAToken)).expect(404);
      const mine = await home(clientAToken);
      expect(mine.plans.map((p) => p.id)).toEqual([planA.id]);
      expect(mine.lastIntake).toEqual(planA.intake);
      expect(mine.draft).toBeNull();
    });

    it('replays a save with the same Idempotency-Key without a second plan', async () => {
      await generate(clientAToken);
      const key = idem();
      const first = await request(server)
        .post(`${base}/plans`)
        .set(as(clientAToken))
        .set(key)
        .send({ name: 'Replayed', makeActive: false })
        .expect(201);
      const second = await request(server)
        .post(`${base}/plans`)
        .set(as(clientAToken))
        .set(key)
        .send({ name: 'Replayed', makeActive: false })
        .expect(200);
      expect(second.body).toEqual(first.body);
      expect(await ctx.prisma.memberWorkoutPlan.count({ where: { memberId: clientAId } })).toBe(2);
    });

    it('keeps one active plan: activating another deactivates the first', async () => {
      const [, replayed] = (await home(clientAToken)).plans.sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const res = await request(server)
        .patch(`${base}/plans/${replayed.id}`)
        .set(as(clientAToken))
        .send({ isActive: true, name: 'Now active' })
        .expect(200);
      expect((res.body as Envelope<MemberWorkoutPlanView>).data).toMatchObject({
        name: 'Now active',
        isActive: true,
      });
      const plans = (await home(clientAToken)).plans;
      expect(plans.filter((p) => p.isActive).map((p) => p.id)).toEqual([replayed.id]);
    });

    it('is scoped to the caller: another member sees 404 on every plan route', async () => {
      await request(server).get(`${base}/plans/${planA.id}`).set(as(clientBToken)).expect(404);
      await request(server)
        .patch(`${base}/plans/${planA.id}`)
        .set(as(clientBToken))
        .send({ name: 'Mine now' })
        .expect(404);
      await request(server)
        .put(`${base}/plans/${planA.id}/body`)
        .set(as(clientBToken))
        .send({ plan: planA.plan })
        .expect(404);
      await request(server).delete(`${base}/plans/${planA.id}`).set(as(clientBToken)).expect(404);
      expect((await home(clientBToken)).plans).toEqual([]);
    });

    it('hand edits go through the schema: 400 WORKOUT_PLAN_INVALID with the error list, else EDITED', async () => {
      const bad = await request(server)
        .put(`${base}/plans/${planA.id}/body`)
        .set(as(clientAToken))
        .send({ plan: { ...planA.plan, days: [] } })
        .expect(400);
      expect((bad.body as Envelope<never>).error).toMatchObject({
        code: 'WORKOUT_PLAN_INVALID',
        details: {
          errors: expect.arrayContaining([expect.stringMatching(/days must hold/)]) as string[],
        },
      });

      const edited = await request(server)
        .put(`${base}/plans/${planA.id}/body`)
        .set(as(clientAToken))
        .send({ plan: { ...planA.plan, summary: '  Edited by hand.  ' } })
        .expect(200);
      expect((edited.body as Envelope<MemberWorkoutPlanView>).data).toMatchObject({
        source: 'EDITED',
        plan: { summary: 'Edited by hand.' },
      });
    });

    it('stops at five plans with 409 WORKOUT_PLAN_LIMIT', async () => {
      // Two exist; three more fit, the sixth does not.
      for (const name of ['Three', 'Four', 'Five']) {
        await generate(clientAToken);
        await savePlan(clientAToken, name);
      }
      await generate(clientAToken);
      const res = await request(server)
        .post(`${base}/plans`)
        .set(as(clientAToken))
        .set(idem())
        .send({ name: 'Six', makeActive: false })
        .expect(409);
      expect((res.body as Envelope<never>).error).toMatchObject({
        code: 'WORKOUT_PLAN_LIMIT',
        message: 'You already keep 5 plans. Delete one to save this.',
      });
      // The draft is still there to save once something is deleted.
      await request(server).delete(`${base}/plans/${planA.id}`).set(as(clientAToken)).expect(200);
      await savePlan(clientAToken, 'Six');
      expect((await home(clientAToken)).plans).toHaveLength(5);
    });
  });

  describe('quota', () => {
    beforeAll(async () => {
      await ctx.prisma.memberWorkoutDraft.deleteMany({ where: { memberId: clientAId } });
    });

    it('stops at eight actions a day with 429 WORKOUT_AI_LIMIT', async () => {
      await ctx.prisma.workoutAiQuota.deleteMany({ where: { memberId: clientAId } });
      const day = await request(server).get(base).set(as(clientAToken)).expect(200);
      expect((day.body as Envelope<WorkoutsHome>).data?.quota.used).toBe(0);

      await ctx.prisma.workoutAiQuota.deleteMany({ where: { memberId: clientAId } });
      // Spend seven directly, then the eighth through the API, then the ninth is refused.
      await request(server)
        .post(`${base}/drafts`)
        .set(as(clientAToken))
        .set(idem())
        .send(INTAKE)
        .expect(202);
      await waitForDraft(clientAToken, (d) => d.status !== 'RUNNING');
      await ctx.prisma.workoutAiQuota.updateMany({
        where: { memberId: clientAId },
        data: { used: 7 },
      });

      await request(server).delete(`${base}/draft`).set(as(clientAToken)).expect(200);
      await request(server)
        .post(`${base}/drafts`)
        .set(as(clientAToken))
        .set(idem())
        .send(INTAKE)
        .expect(202);
      await waitForDraft(clientAToken, (d) => d.status !== 'RUNNING');
      expect((await home(clientAToken)).quota).toMatchObject({ used: 8, remaining: 0 });

      await request(server).delete(`${base}/draft`).set(as(clientAToken)).expect(200);
      const res = await request(server)
        .post(`${base}/drafts`)
        .set(as(clientAToken))
        .set(idem())
        .send(INTAKE)
        .expect(429);
      expect((res.body as Envelope<never>).error).toMatchObject({
        code: 'WORKOUT_AI_LIMIT',
        message: "You've used today's 8 AI actions. They reset at midnight.",
      });
      expect(await ctx.prisma.memberWorkoutDraft.count({ where: { memberId: clientAId } })).toBe(0);
    });
  });

  describe('swap and adjust', () => {
    let plan: MemberWorkoutPlanView;

    beforeAll(async () => {
      await ctx.prisma.workoutAiQuota.deleteMany({ where: { memberId: clientAId } });
      plan = (await home(clientAToken)).plans[0];
    });

    it('swap: 404 for an exercise that is not there, without charging', async () => {
      await request(server)
        .post(`${base}/plans/${plan.id}/swap`)
        .set(as(clientAToken))
        .set(idem())
        .send({ weekday: 2, index: 0 })
        .expect(404);
      await request(server)
        .post(`${base}/plans/${plan.id}/swap`)
        .set(as(clientAToken))
        .set(idem())
        .send({ weekday: 1, index: 5 })
        .expect(404);
      expect(await quotaRow()).toBeNull();
    });

    it('swap: charges one action and returns three validated alternatives', async () => {
      script.json = {
        alternatives: ['Leg press', 'Split squat', 'Step-up'].map((name) => ({
          ...exercise(name),
          why: 'Same pattern, kinder on the knees.',
        })),
      };
      const res = await request(server)
        .post(`${base}/plans/${plan.id}/swap`)
        .set(as(clientAToken))
        .set(idem())
        .send({ weekday: 1, index: 0 })
        .expect(200);
      const body = (res.body as Envelope<SwapResponse>).data!;
      expect(body.alternatives.map((a) => a.name)).toEqual(['Leg press', 'Split squat', 'Step-up']);
      expect(body.quota).toMatchObject({ used: 1, remaining: 7 });
      expect(rotate).toHaveBeenCalledTimes(1);
    });

    it('swap: refunds when the reply is unusable', async () => {
      script.json = { alternatives: [exercise('Only one')] };
      rotate.mockImplementationOnce(
        async (
          _label: string,
          _copy: unknown,
          _budget: number,
          attempt: (model: string, context: AttemptContext) => Promise<unknown>,
        ) => {
          await attempt('stub-model', fakeContext()).catch(() => undefined);
          throw new DomainException('ASSISTANT_BUSY', 'busy', HttpStatus.SERVICE_UNAVAILABLE);
        },
      );
      await request(server)
        .post(`${base}/plans/${plan.id}/swap`)
        .set(as(clientAToken))
        .set(idem())
        .send({ weekday: 1, index: 0 })
        .expect(502);
      expect(await quotaRow()).toBe(1);
    });

    it('adjust: exactly one of preset and request', async () => {
      await request(server)
        .post(`${base}/plans/${plan.id}/adjust`)
        .set(as(clientAToken))
        .set(idem())
        .send({ weekday: 1 })
        .expect(400);
      await request(server)
        .post(`${base}/plans/${plan.id}/adjust`)
        .set(as(clientAToken))
        .set(idem())
        .send({ weekday: 1, preset: 'SHORTER', request: 'More arms' })
        .expect(400);
      expect(await quotaRow()).toBe(1);
    });

    it('adjust: returns the rewritten day for the same weekday and charges one action', async () => {
      script.json = { ...day(3), title: 'Shorter day', minutes: 30 };
      const res = await request(server)
        .post(`${base}/plans/${plan.id}/adjust`)
        .set(as(clientAToken))
        .set(idem())
        .send({ weekday: 3, preset: 'SHORTER' })
        .expect(200);
      expect(
        (res.body as Envelope<{ day: { title: string; weekday: number } }>).data,
      ).toMatchObject({
        day: { weekday: 3, title: 'Shorter day' },
        quota: { used: 2 },
      });
    });
  });

  describe('guides', () => {
    it("404s WORKOUT_EXERCISE_UNKNOWN for a name in none of the caller's plans", async () => {
      const res = await request(server)
        .get(`${base}/guides`)
        .query({ exercise: 'Deadlift' })
        .set(as(clientAToken))
        .expect(404);
      expect((res.body as Envelope<never>).error?.code).toBe('WORKOUT_EXERCISE_UNKNOWN');
      // Another member with no plans cannot ask about this member's exercises either.
      await request(server)
        .get(`${base}/guides`)
        .query({ exercise: 'Goblet squat' })
        .set(as(clientBToken))
        .expect(404);
      expect(rotate).not.toHaveBeenCalled();
    });

    it('asks once, stores the guide, and serves the cache after that — free of charge', async () => {
      script.json = GUIDE;
      const before = await quotaRow();
      const first = await request(server)
        .get(`${base}/guides`)
        .query({ exercise: '  goblet SQUAT ' })
        .set(as(clientAToken))
        .expect(200);
      expect((first.body as Envelope<unknown>).data).toEqual({ name: 'goblet SQUAT', ...GUIDE });
      expect(rotate).toHaveBeenCalledTimes(1);
      expect(
        await ctx.prisma.exerciseGuide.findUnique({ where: { slug: 'goblet-squat' } }),
      ).toMatchObject({
        model: 'stub-model',
      });

      const second = await request(server)
        .get(`${base}/guides`)
        .query({ exercise: 'Goblet squat' })
        .set(as(clientAToken))
        .expect(200);
      expect((second.body as Envelope<unknown>).data).toMatchObject(GUIDE);
      expect(rotate).toHaveBeenCalledTimes(1);
      expect(await quotaRow()).toBe(before);
    });
  });
});
