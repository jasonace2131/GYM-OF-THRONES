import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Server } from 'http';
import type {
  CoachPlanInWorkouts,
  LoggedSet,
  MemberWorkoutPlanView,
  WorkoutSessionSummary,
  WorkoutSessionView,
  WorkoutsHome,
} from '@got/shared';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { GeminiGateway } from '../src/assistant/gemini-gateway.service';
import { GymConfigService } from '../src/config/gym.config';
import { gymToday } from '../src/common/time/gym-time';

jest.setTimeout(120_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: { sessionId?: string | null; errors?: string[] };
  };
}

const exercise = (name: string, restSeconds = 90) => ({
  name,
  muscles: 'Legs · glutes',
  sets: 3,
  reps: '8-12',
  restSeconds,
});

const memberDay = (weekday: number) => ({
  weekday,
  title: `Full body ${weekday}`,
  focus: 'Full body',
  minutes: 45,
  warmUp: '5 min easy bike',
  coolDown: '3 min walk',
  exercises: [exercise('Leg press'), exercise('Shoulder press', 60)],
});

const MEMBER_BODY = {
  summary: 'Two full-body days.',
  days: [memberDay(1), memberDay(3)],
  guidance: [
    { title: 'Sleep', body: '7-9 hours.' },
    { title: 'Water', body: 'Drink before and after.' },
  ],
};

const COACH_BODY = {
  summary: 'Three days from your coach.',
  days: [
    {
      day: 'Monday',
      focus: 'Upper body push',
      exercises: [
        { name: 'Bench press', sets: 4, reps: '6-8', notes: 'Pause on the chest' },
        { name: 'Dips', sets: 3, reps: 'AMRAP' },
      ],
    },
    { day: 'Day 2', focus: 'Legs', exercises: [{ name: 'Back squat', sets: 5, reps: '5' }] },
  ],
};

const GUIDE = {
  steps: ['Lie on the bench.', 'Lower to the chest.', 'Press up.'],
  mistake: 'Bouncing off the chest.',
  easier: 'Use dumbbells.',
  harder: 'Pause longer.',
};

/**
 * Workout sessions, end to end (feat/workout-sessions): the coach's plan on
 * the hub and "use this plan", start from a member day and a coach day, one
 * open at a time, tick / re-tick / untick replayed like the offline queue
 * does, finish (never empty; an idle one at its last set), feeling, last
 * time and new bests, discard, history, and plan deletion keeping history.
 *
 * NO AI is spent anywhere in this round: GeminiGateway.rotate is made to
 * throw, and the How-to check is served from a pre-seeded cache row.
 */
describe('workout sessions (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let rotate: jest.SpyInstance;

  let clientAToken: string;
  let clientBToken: string;
  let coachToken: string;
  let adminToken: string;
  let clientAId: string;
  let coachId: string;
  let memberPlanId: string;
  let timeZone: string;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const idem = () => ({ 'Idempotency-Key': randomUUID() });
  const base = '/api/v1/me/workouts';
  const sessions = `${base}/sessions`;

  const home = async (token: string): Promise<WorkoutsHome> => {
    const res = await request(server).get(base).set(as(token)).expect(200);
    return (res.body as Envelope<WorkoutsHome>).data!;
  };

  const start = async (token: string, body: object, status = 201): Promise<request.Response> =>
    request(server).post(sessions).set(as(token)).set(idem()).send(body).expect(status);

  const startMemberDay = async (weekday = 3): Promise<WorkoutSessionView> =>
    (
      (await start(clientAToken, { source: 'MEMBER_PLAN', planId: memberPlanId, weekday }))
        .body as Envelope<WorkoutSessionView>
    ).data!;

  const tick = (
    id: string,
    exerciseIndex: number,
    setIndex: number,
    body: object,
    token = clientAToken,
  ) =>
    request(server)
      .put(`${sessions}/${id}/sets/${exerciseIndex}/${setIndex}`)
      .set(as(token))
      .send(body);

  const finish = (id: string, body: object = {}) =>
    request(server).post(`${sessions}/${id}/finish`).set(as(clientAToken)).set(idem()).send(body);

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
    await resetDatabase(ctx.prisma);
    timeZone = ctx.app.get(GymConfigService, { strict: false }).timeZone;

    const gateway = ctx.app.get(GeminiGateway, { strict: false });
    rotate = jest.spyOn(gateway, 'rotate').mockImplementation(() => {
      throw new Error('No AI action may be spent by workout sessions');
    });

    clientAToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
    clientBToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_B });
    coachToken = await ctx.fixture.tokenFor('COACH', {
      supabaseId: FIXTURE_IDS.COACH_A,
      firstName: 'Ana',
      lastName: 'Reyes',
    });
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    clientAId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);
    coachId = await ctx.fixture.userIdFor(FIXTURE_IDS.COACH_A);

    // Plans are written straight to the database: generating one is the
    // planner's suite, and this one must spend no AI.
    const plan = await ctx.prisma.memberWorkoutPlan.create({
      data: {
        memberId: clientAId,
        name: 'Strength base',
        goal: 'STRENGTH',
        experience: 'SOME',
        weekdays: [1, 3],
        sessionMinutes: 45,
        timeOfDay: 'EVENING',
        healthFlag: false,
        easyOn: [],
        useMeasurements: false,
        useAttendance: false,
        useBookings: false,
        body: MEMBER_BODY,
        source: 'AI',
        isActive: false,
        consentAt: new Date(),
      },
      select: { id: true },
    });
    memberPlanId = plan.id;
    await ctx.prisma.workoutPlan.create({
      data: { memberId: clientAId, coachId, updatedById: coachId, body: COACH_BODY },
    });
    await ctx.prisma.exerciseGuide.create({
      data: { slug: 'bench-press', name: 'Bench press', body: GUIDE, model: 'seeded' },
    });
  });

  afterAll(async () => {
    expect(rotate).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    await ctx.close();
  });

  describe('access', () => {
    it('is a CLIENT surface: staff without workout.member get 403', async () => {
      await request(server).get(`${sessions}/current`).set(as(coachToken)).expect(403);
      await request(server).get(`${sessions}/current`).set(as(adminToken)).expect(403);
      await request(server)
        .post(sessions)
        .set(as(coachToken))
        .set(idem())
        .send({ source: 'COACH_PLAN', dayIndex: 0 })
        .expect(403);
      await request(server).get(`${sessions}/current`).expect(401);
    });

    it('starts with nothing open and no history', async () => {
      const res = await request(server)
        .get(`${sessions}/current`)
        .set(as(clientAToken))
        .expect(200);
      expect((res.body as Envelope<{ session: null }>).data).toEqual({ session: null });
      const list = await request(server).get(sessions).set(as(clientAToken)).expect(200);
      expect((list.body as Envelope<WorkoutSessionSummary[]>).data).toEqual([]);
    });
  });

  describe("the coach's plan on the hub", () => {
    it("shows it with each day's weekday, active while no AI plan is", async () => {
      const mine = await home(clientAToken);
      expect(mine.coachPlan).toMatchObject({
        plan: COACH_BODY,
        coach: { firstName: 'Ana', lastName: 'Reyes' },
        isActive: true,
        weekdays: [1, null],
      });
      expect(mine.session).toBeNull();
      expect(mine.recent).toEqual([]);
      expect((await home(clientBToken)).coachPlan).toBeNull();
    });

    it('steps back when an AI plan is made active, and "use this plan" brings it back', async () => {
      await request(server)
        .patch(`${base}/plans/${memberPlanId}`)
        .set(as(clientAToken))
        .send({ isActive: true })
        .expect(200);
      expect((await home(clientAToken)).coachPlan?.isActive).toBe(false);

      const res = await request(server)
        .post(`${base}/coach-plan/use`)
        .set(as(clientAToken))
        .set(idem())
        .expect(200);
      expect((res.body as Envelope<CoachPlanInWorkouts>).data).toMatchObject({ isActive: true });
      const after = await home(clientAToken);
      expect(after.coachPlan?.isActive).toBe(true);
      expect(after.plans.every((p: MemberWorkoutPlanView) => !p.isActive)).toBe(true);

      // Idempotent in effect: again is the same answer.
      await request(server)
        .post(`${base}/coach-plan/use`)
        .set(as(clientAToken))
        .set(idem())
        .expect(200);
    });

    it('"use this plan" with no coach plan is 404 WORKOUT_DAY_UNKNOWN', async () => {
      const res = await request(server)
        .post(`${base}/coach-plan/use`)
        .set(as(clientBToken))
        .set(idem())
        .expect(404);
      expect((res.body as Envelope<never>).error?.code).toBe('WORKOUT_DAY_UNKNOWN');
    });
  });

  describe('a workout from a member day', () => {
    let first: WorkoutSessionView;

    it('needs an Idempotency-Key and a well-formed body', async () => {
      await request(server)
        .post(sessions)
        .set(as(clientAToken))
        .send({ source: 'MEMBER_PLAN', planId: memberPlanId, weekday: 3 })
        .expect(400);
      await start(clientAToken, { source: 'MEMBER_PLAN', weekday: 3 }, 400);
      await start(clientAToken, { source: 'COACH_PLAN', dayIndex: 0, planId: memberPlanId }, 400);
      await start(clientAToken, { source: 'MEMBER_PLAN', planId: memberPlanId, weekday: 7 }, 400);
    });

    it("404s a plan that is not the caller's and a weekday the plan has no day for", async () => {
      await start(clientBToken, { source: 'MEMBER_PLAN', planId: memberPlanId, weekday: 3 }, 404);
      const res = await start(
        clientAToken,
        { source: 'MEMBER_PLAN', planId: memberPlanId, weekday: 2 },
        404,
      );
      expect((res.body as Envelope<never>).error?.code).toBe('WORKOUT_DAY_UNKNOWN');
    });

    it("snapshots the day on the gym's today, with no history yet", async () => {
      first = await startMemberDay(3);
      expect(first).toMatchObject({
        source: 'MEMBER_PLAN',
        planName: 'Strength base',
        coach: null,
        dayTitle: 'Full body 3',
        weekday: 3,
        businessDate: gymToday(new Date(), timeZone),
        finishedAt: null,
        feeling: null,
        sets: [],
      });
      expect(first.exercises).toEqual([
        { ...exercise('Leg press'), lastTime: null, bestKg: null },
        { ...exercise('Shoulder press', 60), lastTime: null, bestKg: null },
      ]);
    });

    it('keeps ONE open workout: a second start is 409 WORKOUT_SESSION_OPEN naming it', async () => {
      const res = await start(
        clientAToken,
        { source: 'MEMBER_PLAN', planId: memberPlanId, weekday: 1 },
        409,
      );
      expect((res.body as Envelope<never>).error).toMatchObject({
        code: 'WORKOUT_SESSION_OPEN',
        details: { sessionId: first.id },
      });
      const current = await request(server).get(`${sessions}/current`).set(as(clientAToken));
      expect((current.body as Envelope<{ session: WorkoutSessionView }>).data?.session.id).toBe(
        first.id,
      );
      expect((await home(clientAToken)).session?.id).toBe(first.id);
    });

    it('replays a start with the same Idempotency-Key as the first answer, not a 409', async () => {
      const key = { 'Idempotency-Key': randomUUID() };
      await request(server).delete(`${sessions}/${first.id}`).set(as(clientAToken)).expect(200);
      const one = await request(server)
        .post(sessions)
        .set(as(clientAToken))
        .set(key)
        .send({ source: 'MEMBER_PLAN', planId: memberPlanId, weekday: 3 })
        .expect(201);
      const two = await request(server)
        .post(sessions)
        .set(as(clientAToken))
        .set(key)
        .send({ source: 'MEMBER_PLAN', planId: memberPlanId, weekday: 3 })
        .expect(200);
      expect(two.body).toEqual(one.body);
      first = (one.body as Envelope<WorkoutSessionView>).data!;
    });

    it("is the caller's alone: another member gets 404 on every route", async () => {
      await request(server).get(`${sessions}/${first.id}`).set(as(clientBToken)).expect(404);
      await tick(first.id, 0, 0, { weightKg: 20, reps: 10 }, clientBToken).expect(404);
      await request(server)
        .delete(`${sessions}/${first.id}/sets/0/0`)
        .set(as(clientBToken))
        .expect(404);
      await request(server)
        .post(`${sessions}/${first.id}/finish`)
        .set(as(clientBToken))
        .set(idem())
        .send({})
        .expect(404);
      await request(server).delete(`${sessions}/${first.id}`).set(as(clientBToken)).expect(404);
    });

    it('ticks a set, and a replayed tick changes nothing', async () => {
      const one = await tick(first.id, 0, 0, { weightKg: 80, reps: 10 }).expect(200);
      const logged = (one.body as Envelope<LoggedSet>).data!;
      expect(logged).toMatchObject({ exerciseIndex: 0, setIndex: 0, weightKg: 80, reps: 10 });

      const again = await tick(first.id, 0, 0, { weightKg: 80, reps: 10 }).expect(200);
      expect((again.body as Envelope<LoggedSet>).data).toEqual(logged);
      expect(await ctx.prisma.workoutSetLog.count({ where: { sessionId: first.id } })).toBe(1);
    });

    it('re-ticks with new numbers, keeping the first tick time', async () => {
      const before = await ctx.prisma.workoutSetLog.findFirstOrThrow({
        where: { sessionId: first.id, exerciseIndex: 0, setIndex: 0 },
      });
      const res = await tick(first.id, 0, 0, { weightKg: 82.5, reps: 8 }).expect(200);
      expect((res.body as Envelope<LoggedSet>).data).toMatchObject({
        weightKg: 82.5,
        reps: 8,
        completedAt: before.completedAt.toISOString(),
      });
      expect(
        await ctx.prisma.workoutSetLog.findFirstOrThrow({
          where: { sessionId: first.id, exerciseIndex: 0, setIndex: 0 },
        }),
      ).toMatchObject({ weightGrams: 82_500, reps: 8, exerciseSlug: 'leg-press' });
    });

    it('refuses a bad set with 400 WORKOUT_SET_INVALID', async () => {
      for (const body of [
        { weightKg: '20', reps: 10 },
        { weightKg: 12.345, reps: 10 },
        { weightKg: 20, reps: 0 },
        { reps: 10 },
      ]) {
        const res = await tick(first.id, 0, 1, body).expect(400);
        expect((res.body as Envelope<never>).error?.code).toBe('WORKOUT_SET_INVALID');
      }
      for (const [exerciseIndex, setIndex] of [
        [2, 0], // the snapshot has two exercises
        [12, 0],
        [0, 20],
      ]) {
        const res = await tick(first.id, exerciseIndex, setIndex, {
          weightKg: 20,
          reps: 10,
        }).expect(400);
        expect((res.body as Envelope<never>).error?.code).toBe('WORKOUT_SET_INVALID');
      }
      // An unknown field is the pipe's plain 400.
      await tick(first.id, 0, 1, { weightKg: 20, reps: 10, done: true }).expect(400);
    });

    it('unticks, and a replayed untick says it found nothing', async () => {
      await tick(first.id, 1, 0, { weightKg: null, reps: 12 }).expect(200);
      const one = await request(server)
        .delete(`${sessions}/${first.id}/sets/1/0`)
        .set(as(clientAToken))
        .expect(200);
      expect((one.body as Envelope<{ deleted: boolean }>).data).toEqual({ deleted: true });
      const two = await request(server)
        .delete(`${sessions}/${first.id}/sets/1/0`)
        .set(as(clientAToken))
        .expect(200);
      expect((two.body as Envelope<{ deleted: boolean }>).data).toEqual({ deleted: false });
    });

    it('lands where an offline queue replayed in order leaves it', async () => {
      await tick(first.id, 0, 1, { weightKg: 80, reps: 9 }).expect(200);
      await request(server).delete(`${sessions}/${first.id}/sets/0/1`).set(as(clientAToken));
      await tick(first.id, 0, 1, { weightKg: 80, reps: 10 }).expect(200);
      await tick(first.id, 0, 1, { weightKg: 80, reps: 10 }).expect(200);

      const view = await request(server).get(`${sessions}/${first.id}`).set(as(clientAToken));
      expect(
        (view.body as Envelope<WorkoutSessionView>).data?.sets.map((s) => [
          s.exerciseIndex,
          s.setIndex,
          s.weightKg,
          s.reps,
        ]),
      ).toEqual([
        [0, 0, 82.5, 8],
        [0, 1, 80, 10],
      ]);
    });

    it('finishes with a summary, and a second finish answers the same', async () => {
      const res = await finish(first.id, { feeling: 'RIGHT' }).expect(200);
      const summary = (res.body as Envelope<WorkoutSessionSummary>).data!;
      expect(summary).toMatchObject({
        id: first.id,
        source: 'MEMBER_PLAN',
        planName: 'Strength base',
        dayTitle: 'Full body 3',
        setsDone: 2,
        exercisesDone: 1,
        exerciseCount: 2,
        volumeKg: Math.round(82.5 * 8 + 80 * 10),
        bests: [],
        feeling: 'RIGHT',
      });
      expect(summary.durationMinutes).toBeGreaterThanOrEqual(1);
      expect(summary.perExercise[0]).toEqual({
        name: 'Leg press',
        setsDone: 2,
        plannedSets: 3,
        top: { weightKg: 82.5, reps: 8 },
      });

      const again = await finish(first.id, { feeling: 'HARD' }).expect(200);
      expect((again.body as Envelope<WorkoutSessionSummary>).data).toEqual(summary);
    });

    it('freezes a finished workout: its sets 409 and it cannot be discarded', async () => {
      const put = await tick(first.id, 0, 2, { weightKg: 80, reps: 10 }).expect(409);
      expect((put.body as Envelope<never>).error?.code).toBe('WORKOUT_SESSION_FINISHED');
      await request(server)
        .delete(`${sessions}/${first.id}/sets/0/0`)
        .set(as(clientAToken))
        .expect(409);
      const discard = await request(server)
        .delete(`${sessions}/${first.id}`)
        .set(as(clientAToken))
        .expect(409);
      expect((discard.body as Envelope<never>).error?.code).toBe('WORKOUT_SESSION_FINISHED');
    });

    it('takes a feeling afterwards, or clears it', async () => {
      const res = await request(server)
        .patch(`${sessions}/${first.id}`)
        .set(as(clientAToken))
        .send({ feeling: 'EASY' })
        .expect(200);
      expect((res.body as Envelope<WorkoutSessionSummary>).data?.feeling).toBe('EASY');
      await request(server)
        .patch(`${sessions}/${first.id}`)
        .set(as(clientAToken))
        .send({ feeling: null })
        .expect(200);
      await request(server)
        .patch(`${sessions}/${first.id}`)
        .set(as(clientAToken))
        .send({ feeling: 'MEH' })
        .expect(400);
    });

    it('shows up in history, the hub and its own summary', async () => {
      const list = await request(server).get(sessions).set(as(clientAToken)).expect(200);
      expect((list.body as Envelope<WorkoutSessionSummary[]>).data?.map((s) => s.id)).toEqual([
        first.id,
      ]);
      const mine = await home(clientAToken);
      expect(mine.session).toBeNull();
      expect(mine.recent.map((s) => s.id)).toEqual([first.id]);
      await request(server)
        .get(`${sessions}/${first.id}/summary`)
        .set(as(clientAToken))
        .expect(200);
    });

    it('next time: "last time" is that workout\'s sets, and heavier is a new best', async () => {
      const second = await startMemberDay(3);
      expect(second.exercises[0]).toMatchObject({
        lastTime: {
          date: first.businessDate,
          sets: [
            { weightKg: 82.5, reps: 8 },
            { weightKg: 80, reps: 10 },
          ],
        },
        bestKg: 82.5,
      });
      expect(second.exercises[1]).toMatchObject({ lastTime: null, bestKg: null });

      // A summary of an open workout does not exist yet.
      const early = await request(server)
        .get(`${sessions}/${second.id}/summary`)
        .set(as(clientAToken))
        .expect(409);
      expect((early.body as Envelope<never>).error?.code).toBe('WORKOUT_SESSION_OPEN');

      await tick(second.id, 0, 0, { weightKg: 85, reps: 6 }).expect(200);
      const res = await finish(second.id).expect(200);
      expect((res.body as Envelope<WorkoutSessionSummary>).data?.bests).toEqual([
        { exerciseName: 'Leg press', weightKg: 85, reps: 6, previousKg: 82.5 },
      ]);
    });
  });

  describe('finish rules', () => {
    it('refuses an empty workout with 422 WORKOUT_SESSION_EMPTY; discard is the way out', async () => {
      const open = await startMemberDay(1);
      const res = await finish(open.id).expect(422);
      expect((res.body as Envelope<never>).error?.code).toBe('WORKOUT_SESSION_EMPTY');

      const gone = await request(server)
        .delete(`${sessions}/${open.id}`)
        .set(as(clientAToken))
        .expect(200);
      expect((gone.body as Envelope<{ id: string }>).data).toEqual({ id: open.id });
      await request(server).get(`${sessions}/${open.id}`).set(as(clientAToken)).expect(404);
    });

    it('discarding takes the ticked sets with it', async () => {
      const open = await startMemberDay(1);
      await tick(open.id, 0, 0, { weightKg: 60, reps: 10 }).expect(200);
      await request(server).delete(`${sessions}/${open.id}`).set(as(clientAToken)).expect(200);
      expect(await ctx.prisma.workoutSetLog.count({ where: { sessionId: open.id } })).toBe(0);
    });

    it('closes a workout left idle at its last set, not at now', async () => {
      const open = await startMemberDay(1);
      await tick(open.id, 0, 0, { weightKg: 60, reps: 10 }).expect(200);
      const lastAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
      await ctx.prisma.workoutSession.update({
        where: { id: open.id },
        data: { startedAt: new Date(lastAt.getTime() - 10 * 60 * 1000) },
      });
      await ctx.prisma.workoutSetLog.updateMany({
        where: { sessionId: open.id },
        data: { completedAt: lastAt },
      });

      const res = await finish(open.id).expect(200);
      const summary = (res.body as Envelope<WorkoutSessionSummary>).data!;
      expect(summary.finishedAt).toBe(lastAt.toISOString());
      expect(summary.durationMinutes).toBe(10);
    });
  });

  describe("a workout from the coach's plan", () => {
    it("snapshots the coach's day: the coach's name, the label's weekday, the default rest", async () => {
      const res = await start(clientAToken, { source: 'COACH_PLAN', dayIndex: 0 });
      const view = (res.body as Envelope<WorkoutSessionView>).data!;
      expect(view).toMatchObject({
        source: 'COACH_PLAN',
        planName: "Coach Ana's plan",
        coach: { firstName: 'Ana', lastName: 'Reyes' },
        dayTitle: 'Upper body push',
        weekday: 1,
      });
      expect(view.exercises.map((e) => [e.name, e.muscles, e.restSeconds, e.notes])).toEqual([
        ['Bench press', null, 90, 'Pause on the chest'],
        ['Dips', null, 90, undefined],
      ]);

      // How to works on a coach exercise (served from the cache: no AI).
      await request(server)
        .get(`${base}/guides`)
        .query({ exercise: 'Bench press' })
        .set(as(clientAToken))
        .expect(200);
      await request(server)
        .get(`${base}/guides`)
        .query({ exercise: 'Bench press' })
        .set(as(clientBToken))
        .expect(404);

      await request(server).delete(`${sessions}/${view.id}`).set(as(clientAToken)).expect(200);
    });

    it('a day whose label names no weekday starts with a null weekday', async () => {
      const res = await start(clientAToken, { source: 'COACH_PLAN', dayIndex: 1 });
      const view = (res.body as Envelope<WorkoutSessionView>).data!;
      expect(view).toMatchObject({ weekday: null, dayTitle: 'Legs' });
      await request(server).delete(`${sessions}/${view.id}`).set(as(clientAToken)).expect(200);
    });

    it('404 WORKOUT_DAY_UNKNOWN past the last day, or with no coach plan', async () => {
      const past = await start(clientAToken, { source: 'COACH_PLAN', dayIndex: 2 }, 404);
      expect((past.body as Envelope<never>).error?.code).toBe('WORKOUT_DAY_UNKNOWN');
      const none = await start(clientBToken, { source: 'COACH_PLAN', dayIndex: 0 }, 404);
      expect((none.body as Envelope<never>).error?.code).toBe('WORKOUT_DAY_UNKNOWN');
    });
  });

  describe('history outlives the plan', () => {
    it('deleting the member plan keeps every finished workout and its summary', async () => {
      const before = await request(server).get(sessions).set(as(clientAToken)).expect(200);
      const ids = (before.body as Envelope<WorkoutSessionSummary[]>).data!.map((s) => s.id);
      expect(ids.length).toBeGreaterThanOrEqual(3);

      await request(server)
        .delete(`${base}/plans/${memberPlanId}`)
        .set(as(clientAToken))
        .expect(200);

      const after = await request(server).get(sessions).set(as(clientAToken)).expect(200);
      expect((after.body as Envelope<WorkoutSessionSummary[]>).data).toEqual(
        (before.body as Envelope<WorkoutSessionSummary[]>).data,
      );
      expect(
        await ctx.prisma.workoutSession.count({
          where: { memberId: clientAId, memberPlanId: { not: null } },
        }),
      ).toBe(0);

      const limited = await request(server)
        .get(sessions)
        .query({ limit: 1 })
        .set(as(clientAToken))
        .expect(200);
      expect((limited.body as Envelope<WorkoutSessionSummary[]>).data?.map((s) => s.id)).toEqual([
        ids[0],
      ]);
      await request(server).get(sessions).query({ limit: 51 }).set(as(clientAToken)).expect(400);
    });
  });
});
