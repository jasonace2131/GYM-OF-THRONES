import { HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { SESSION_IDLE_CLOSE_MS, type SessionExercise, type WorkoutPlanView } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import type { GymConfigService } from '../config/gym.config';
import type { PrismaService } from '../prisma/prisma.service';
import type { WorkoutPlansService } from '../workout-plans/workout-plans.service';
import type { SessionRow, SetRow } from './workout-sessions.presenter';
import { WorkoutSessionsService } from './workout-sessions.service';

/**
 * Workout sessions (feat/workout-sessions): start from a day of the member's
 * plan or the coach's, one open at a time; tick and untick sets by key;
 * finish (never empty, an idle session at its last set); feeling; discard;
 * history with "last time" and "best" from one query each.
 */

const MEMBER = 'a0000000-0000-4000-8000-000000000001';
const SESSION_ID = 'b0000000-0000-4000-8000-000000000001';
const OTHER_SESSION = 'b0000000-0000-4000-8000-000000000002';
const PLAN_ID = 'c0000000-0000-4000-8000-000000000001';
const COACH_PLAN_ID = 'd0000000-0000-4000-8000-000000000001';
// 10:00 in Manila on Wednesday 30 September.
const NOW = new Date('2026-09-30T02:00:00.000Z');

const memberExercise = (name: string, restSeconds = 90) => ({
  name,
  muscles: 'Legs',
  sets: 3,
  reps: '8-12',
  restSeconds,
});

const memberDay = (weekday: number) => ({
  weekday,
  title: `Full body ${weekday}`,
  focus: 'Everything',
  minutes: 45,
  warmUp: 'Bike',
  coolDown: 'Walk',
  exercises: [memberExercise('Leg press'), memberExercise('Shoulder press', 60)],
});

const MEMBER_BODY = {
  summary: 'Two days.',
  days: [memberDay(1), memberDay(3)],
  guidance: [
    { title: 'Sleep', body: '7-9 hours.' },
    { title: 'Water', body: 'Drink up.' },
  ],
};

const COACH_VIEW: WorkoutPlanView = {
  plan: {
    summary: 'Coach plan.',
    days: [
      {
        day: 'Wednesday',
        focus: 'Upper body push and a very long focus text',
        exercises: [
          { name: 'Bench press', sets: 4, reps: '6-8', notes: 'Pause' },
          { name: 'Dips', sets: 3, reps: 'AMRAP' },
        ],
      },
      { day: 'Day 2', focus: 'Legs', exercises: [{ name: 'Squat', sets: 5, reps: '5' }] },
    ],
  },
  coach: { firstName: 'Ana', lastName: 'Reyes' },
  updatedAt: NOW.toISOString(),
};

const SNAPSHOT: SessionExercise[] = [
  { name: 'Leg press', muscles: 'Legs', sets: 3, reps: '8-12', restSeconds: 90 },
  { name: 'Shoulder press', muscles: 'Legs', sets: 3, reps: '8-12', restSeconds: 60 },
  { name: 'Dead bug', muscles: null, sets: 2, reps: '10', restSeconds: 45 },
];

const STARTED = new Date(NOW.getTime() - 50 * 60_000);

const sessionRow = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: SESSION_ID,
  source: 'MEMBER_PLAN',
  planName: 'Strength base',
  coachFirstName: null,
  coachLastName: null,
  dayTitle: 'Full body 3',
  weekday: 3,
  exercises: SNAPSHOT as unknown as SessionRow['exercises'],
  businessDate: new Date('2026-09-30T00:00:00.000Z'),
  startedAt: STARTED,
  finishedAt: null,
  feeling: null,
  ...over,
});

const setRow = (
  exerciseIndex: number,
  setIndex: number,
  minutesAfterStart: number,
  over: Partial<SetRow> = {},
): SetRow => ({
  exerciseIndex,
  setIndex,
  weightGrams: 80_000,
  reps: 10,
  completedAt: new Date(STARTED.getTime() + minutesAfterStart * 60_000),
  ...over,
});

/** The first argument of a mock's call, typed by the caller. */
const argOf = <T>(mock: jest.Mock, call = 0): T => (mock.mock.calls[call] as [T])[0];

const failure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (caught: unknown) => caught,
  );

describe('WorkoutSessionsService', () => {
  let sessions: {
    createMany: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  let setLogs: { upsert: jest.Mock; deleteMany: jest.Mock; findMany: jest.Mock };
  let memberPlans: { findFirst: jest.Mock };
  let prisma: {
    workoutSession: typeof sessions;
    workoutSetLog: typeof setLogs;
    memberWorkoutPlan: typeof memberPlans;
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
  };
  let coachPlans: { planForMember: jest.Mock };
  /** What each raw query answers: the row lock, "last time", and "best". */
  let raw: {
    lock: Array<{ id: string; startedAt: Date; finishedAt: Date | null; exercises: unknown }>;
    lastTime: Array<{ slug: string; date: string; weightGrams: number | null; reps: number }>;
    best: Array<{ sessionId: string; slug: string; bestGrams: number | null }>;
  };
  let rawCalls: Array<{ sql: string; values: unknown[] }>;
  let logs: string[];

  const build = (): WorkoutSessionsService =>
    new WorkoutSessionsService(
      prisma as unknown as PrismaService,
      { timeZone: 'Asia/Manila' } as unknown as GymConfigService,
      coachPlans as unknown as WorkoutPlansService,
    );

  const rawOf = (kind: 'lock' | 'lastTime' | 'best') =>
    rawCalls.filter((call) =>
      kind === 'lock'
        ? /FOR UPDATE/.test(call.sql)
        : kind === 'best'
          ? /"bestGrams"/.test(call.sql)
          : /LATERAL/.test(call.sql),
    );

  beforeEach(() => {
    sessions = {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    setLogs = {
      upsert: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    };
    memberPlans = {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: PLAN_ID, name: 'Strength base', body: MEMBER_BODY }),
    };
    raw = { lock: [], lastTime: [], best: [] };
    rawCalls = [];
    prisma = {
      workoutSession: sessions,
      workoutSetLog: setLogs,
      memberWorkoutPlan: memberPlans,
      $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('$?');
        rawCalls.push({ sql, values });
        if (/FOR UPDATE/.test(sql)) return Promise.resolve(raw.lock);
        if (/"bestGrams"/.test(sql)) return Promise.resolve(raw.best);
        if (/LATERAL/.test(sql)) return Promise.resolve(raw.lastTime);
        return Promise.reject(new Error(`unexpected SQL: ${sql}`));
      }),
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    coachPlans = { planForMember: jest.fn().mockResolvedValue(null) };
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push(String(args[0]));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  // ── Start ────────────────────────────────────────────────────────────────

  describe('start', () => {
    it("snapshots the member plan's day, on the gym's today, with ON CONFLICT DO NOTHING", async () => {
      const view = await build().start(
        MEMBER,
        { source: 'MEMBER_PLAN', planId: PLAN_ID, weekday: 3 },
        NOW,
      );

      expect(argOf<object>(memberPlans.findFirst)).toMatchObject({
        where: { id: PLAN_ID, memberId: MEMBER },
      });
      const insert = argOf<{ data: Array<Record<string, unknown>>; skipDuplicates: boolean }>(
        sessions.createMany,
      );
      expect(insert.skipDuplicates).toBe(true);
      expect(insert.data).toHaveLength(1);
      expect(insert.data[0]).toMatchObject({
        memberId: MEMBER,
        source: 'MEMBER_PLAN',
        memberPlanId: PLAN_ID,
        coachPlanId: null,
        planName: 'Strength base',
        coachFirstName: null,
        coachLastName: null,
        dayTitle: 'Full body 3',
        weekday: 3,
        exercises: [
          { name: 'Leg press', muscles: 'Legs', sets: 3, reps: '8-12', restSeconds: 90 },
          { name: 'Shoulder press', muscles: 'Legs', sets: 3, reps: '8-12', restSeconds: 60 },
        ],
        businessDate: new Date('2026-09-30T00:00:00.000Z'),
        startedAt: NOW,
      });
      expect(insert.data[0]['id']).toEqual(expect.any(String));
      // Never a caught violation inside a transaction (25P02).
      expect(prisma.$transaction).not.toHaveBeenCalled();

      expect(view).toMatchObject({
        id: insert.data[0]['id'],
        source: 'MEMBER_PLAN',
        planName: 'Strength base',
        coach: null,
        weekday: 3,
        businessDate: '2026-09-30',
        startedAt: NOW.toISOString(),
        finishedAt: null,
        sets: [],
      });
      expect(view.exercises.map((e) => e.name)).toEqual(['Leg press', 'Shoulder press']);
    });

    it("attaches last time and best from ONE query each, for every exercise's slug", async () => {
      raw.lastTime = [
        { slug: 'leg-press', date: '2026-09-28', weightGrams: 75_000, reps: 12 },
        { slug: 'leg-press', date: '2026-09-28', weightGrams: 77_500, reps: 10 },
      ];
      raw.best = [
        { sessionId: 'ignored-by-slug', slug: 'leg-press', bestGrams: 80_000 },
        { sessionId: 'ignored-by-slug', slug: 'shoulder-press', bestGrams: null },
      ];

      const view = await build().start(
        MEMBER,
        { source: 'MEMBER_PLAN', planId: PLAN_ID, weekday: 3 },
        NOW,
      );

      expect(rawOf('lastTime')).toHaveLength(1);
      expect(rawOf('best')).toHaveLength(1);
      expect(rawOf('lastTime')[0].values).toContainEqual(['leg-press', 'shoulder-press']);
      expect(rawOf('lastTime')[0].values).toContain(MEMBER);
      expect(view.exercises[0]).toMatchObject({
        lastTime: {
          date: '2026-09-28',
          sets: [
            { weightKg: 75, reps: 12 },
            { weightKg: 77.5, reps: 10 },
          ],
        },
        bestKg: 80,
      });
      expect(view.exercises[1]).toMatchObject({ lastTime: null, bestKg: null });
    });

    it("404s a plan that is not the caller's, and 404 WORKOUT_DAY_UNKNOWN for a weekday it has no day for", async () => {
      memberPlans.findFirst.mockResolvedValueOnce(null);
      await expect(
        build().start(MEMBER, { source: 'MEMBER_PLAN', planId: PLAN_ID, weekday: 3 }, NOW),
      ).rejects.toBeInstanceOf(NotFoundException);

      const caught = await failure(
        build().start(MEMBER, { source: 'MEMBER_PLAN', planId: PLAN_ID, weekday: 2 }, NOW),
      );
      expect(caught).toMatchObject({ code: 'WORKOUT_DAY_UNKNOWN' });
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(sessions.createMany).not.toHaveBeenCalled();
    });

    it("snapshots the coach's day with the default rest, the coach's name and the label's weekday", async () => {
      coachPlans.planForMember.mockResolvedValue({ id: COACH_PLAN_ID, view: COACH_VIEW });

      const view = await build().start(MEMBER, { source: 'COACH_PLAN', dayIndex: 0 }, NOW);

      expect(coachPlans.planForMember).toHaveBeenCalledWith(MEMBER);
      const insert = argOf<{ data: Array<Record<string, unknown>> }>(sessions.createMany);
      expect(insert.data[0]).toMatchObject({
        source: 'COACH_PLAN',
        memberPlanId: null,
        coachPlanId: COACH_PLAN_ID,
        planName: "Coach Ana's plan",
        coachFirstName: 'Ana',
        coachLastName: 'Reyes',
        weekday: 3,
        exercises: [
          {
            name: 'Bench press',
            muscles: null,
            sets: 4,
            reps: '6-8',
            restSeconds: 90,
            notes: 'Pause',
          },
          { name: 'Dips', muscles: null, sets: 3, reps: 'AMRAP', restSeconds: 90 },
        ],
      });
      // The day's focus is its title, clipped to the column's 40 characters.
      expect((insert.data[0]['dayTitle'] as string).length).toBeLessThanOrEqual(40);
      expect(insert.data[0]['dayTitle']).toMatch(/^Upper body push/);
      expect(view.coach).toEqual({ firstName: 'Ana', lastName: 'Reyes' });

      await build().start(MEMBER, { source: 'COACH_PLAN', dayIndex: 1 }, NOW);
      const second = argOf<{ data: Array<Record<string, unknown>> }>(sessions.createMany, 1);
      expect(second.data[0]).toMatchObject({ weekday: null, dayTitle: 'Legs' });
    });

    it('404 WORKOUT_DAY_UNKNOWN with no coach plan, or a day index it does not have', async () => {
      const none = await failure(build().start(MEMBER, { source: 'COACH_PLAN', dayIndex: 0 }, NOW));
      expect(none).toMatchObject({ code: 'WORKOUT_DAY_UNKNOWN' });

      coachPlans.planForMember.mockResolvedValue({ id: COACH_PLAN_ID, view: COACH_VIEW });
      const past = await failure(build().start(MEMBER, { source: 'COACH_PLAN', dayIndex: 2 }, NOW));
      expect(past).toMatchObject({ code: 'WORKOUT_DAY_UNKNOWN' });
      expect(sessions.createMany).not.toHaveBeenCalled();
    });

    it('answers 409 WORKOUT_SESSION_OPEN naming the open session when the insert found one', async () => {
      sessions.createMany.mockResolvedValue({ count: 0 });
      sessions.findFirst.mockResolvedValue({ id: OTHER_SESSION });

      const caught = await failure(
        build().start(MEMBER, { source: 'MEMBER_PLAN', planId: PLAN_ID, weekday: 3 }, NOW),
      );

      expect(caught).toMatchObject({
        code: 'WORKOUT_SESSION_OPEN',
        details: { sessionId: OTHER_SESSION },
      });
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.CONFLICT);
      expect(argOf<object>(sessions.findFirst)).toMatchObject({
        where: { memberId: MEMBER, finishedAt: null },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('retries once when the open session it collided with was finished in between', async () => {
      sessions.createMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
      sessions.findFirst.mockResolvedValueOnce(null);

      await build().start(MEMBER, { source: 'MEMBER_PLAN', planId: PLAN_ID, weekday: 3 }, NOW);

      expect(sessions.createMany).toHaveBeenCalledTimes(2);
    });

    it('logs counts only — no member, plan or exercise names', async () => {
      await build().start(MEMBER, { source: 'MEMBER_PLAN', planId: PLAN_ID, weekday: 3 }, NOW);
      expect(logs.some((line) => /workout-session started/.test(line))).toBe(true);
      for (const secret of [MEMBER, PLAN_ID, 'Strength base', 'Leg press']) {
        expect(logs.join('\n')).not.toContain(secret);
      }
    });
  });

  // ── Reads ────────────────────────────────────────────────────────────────

  describe('get and current', () => {
    it('reads by id AND member; an unscoped miss is 404 WORKOUT_SESSION_MISSING', async () => {
      const caught = await failure(build().get(MEMBER, SESSION_ID));
      expect(caught).toMatchObject({ code: 'WORKOUT_SESSION_MISSING' });
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(argOf<object>(sessions.findFirst)).toMatchObject({
        where: { id: SESSION_ID, memberId: MEMBER },
      });
    });

    it('shows the ticked sets and asks "last time" of sessions BEFORE this one', async () => {
      sessions.findFirst.mockResolvedValue({
        ...sessionRow(),
        sets: [setRow(0, 0, 5), setRow(0, 1, 7, { weightGrams: null })],
      });

      const view = await build().get(MEMBER, SESSION_ID);

      expect(view.sets).toEqual([
        {
          exerciseIndex: 0,
          setIndex: 0,
          weightKg: 80,
          reps: 10,
          completedAt: new Date(STARTED.getTime() + 5 * 60_000).toISOString(),
        },
        {
          exerciseIndex: 0,
          setIndex: 1,
          weightKg: null,
          reps: 10,
          completedAt: new Date(STARTED.getTime() + 7 * 60_000).toISOString(),
        },
      ]);
      expect(rawOf('lastTime')[0].values).toContain(STARTED.toISOString());
      expect(rawOf('lastTime')[0].values).toContainEqual([
        'leg-press',
        'shoulder-press',
        'dead-bug',
      ]);
      expect(rawCalls).toHaveLength(2);
    });

    it('current: null when nothing is open, the view when something is', async () => {
      await expect(build().current(MEMBER)).resolves.toBeNull();
      expect(argOf<object>(sessions.findFirst)).toMatchObject({
        where: { memberId: MEMBER, finishedAt: null },
      });

      sessions.findFirst.mockResolvedValue({ ...sessionRow(), sets: [] });
      await expect(build().current(MEMBER)).resolves.toMatchObject({ id: SESSION_ID });
    });

    it('treats a stored snapshot that fails the shape as nothing to show, and logs it', async () => {
      sessions.findFirst.mockResolvedValue({
        ...sessionRow({ exercises: [{ name: 1 }] }),
        sets: [],
      });
      await expect(build().current(MEMBER)).resolves.toBeNull();
      await expect(build().get(MEMBER, SESSION_ID)).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_MISSING',
      });
      expect(logs.some((line) => /fails the snapshot shape/.test(line))).toBe(true);
    });
  });

  // ── Sets ─────────────────────────────────────────────────────────────────

  describe('logSet', () => {
    beforeEach(() => {
      raw.lock = [{ id: SESSION_ID, startedAt: STARTED, finishedAt: null, exercises: SNAPSHOT }];
      setLogs.upsert.mockResolvedValue(setRow(1, 2, 20, { weightGrams: 22_250, reps: 8 }));
    });

    it('refuses a bad index before touching the database — 400 WORKOUT_SET_INVALID', async () => {
      for (const [exerciseIndex, setIndex] of [
        ['12', '0'],
        ['-1', '0'],
        ['x', '0'],
        ['1.5', '0'],
        ['0', '20'],
        ['0', ''],
      ]) {
        const caught = await failure(
          build().logSet(
            MEMBER,
            SESSION_ID,
            exerciseIndex,
            setIndex,
            { weightKg: 20, reps: 10 },
            NOW,
          ),
        );
        expect(caught).toMatchObject({ code: 'WORKOUT_SET_INVALID' });
        expect((caught as DomainException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("refuses a body that breaks parseLogSetBody, with the parser's errors", async () => {
      const caught = await failure(
        build().logSet(MEMBER, SESSION_ID, '0', '0', { weightKg: 12.345, reps: 0 }, NOW),
      );
      expect(caught).toMatchObject({ code: 'WORKOUT_SET_INVALID' });
      expect((caught as DomainException).details).toMatchObject({
        errors: expect.arrayContaining([
          expect.stringMatching(/weightKg/),
          expect.stringMatching(/reps/),
        ]) as string[],
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('locks the session row (by id AND member) in a transaction', async () => {
      await build().logSet(MEMBER, SESSION_ID, '1', '2', { weightKg: 22.25, reps: 8 }, NOW);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const [lock] = rawOf('lock');
      expect(lock.sql).toMatch(/"memberId"/);
      expect(lock.values).toEqual(expect.arrayContaining([SESSION_ID, MEMBER]));
    });

    it('404 when the lock finds nothing, 409 WORKOUT_SESSION_FINISHED on a finished one', async () => {
      raw.lock = [];
      const missing = await failure(
        build().logSet(MEMBER, SESSION_ID, '0', '0', { weightKg: 20, reps: 10 }, NOW),
      );
      expect(missing).toMatchObject({ code: 'WORKOUT_SESSION_MISSING' });

      raw.lock = [{ id: SESSION_ID, startedAt: STARTED, finishedAt: NOW, exercises: SNAPSHOT }];
      const finished = await failure(
        build().logSet(MEMBER, SESSION_ID, '0', '0', { weightKg: 20, reps: 10 }, NOW),
      );
      expect(finished).toMatchObject({ code: 'WORKOUT_SESSION_FINISHED' });
      expect((finished as DomainException).getStatus()).toBe(HttpStatus.CONFLICT);
      expect(setLogs.upsert).not.toHaveBeenCalled();
    });

    it('400 for an exercise index past this snapshot', async () => {
      const caught = await failure(
        build().logSet(MEMBER, SESSION_ID, '3', '0', { weightKg: 20, reps: 10 }, NOW),
      );
      expect(caught).toMatchObject({ code: 'WORKOUT_SET_INVALID' });
      expect(setLogs.upsert).not.toHaveBeenCalled();
    });

    it('upserts on the composite key: grams, name and slug on create, only the numbers on update', async () => {
      const logged = await build().logSet(
        MEMBER,
        SESSION_ID,
        '1',
        '2',
        { weightKg: 22.25, reps: 8 },
        NOW,
      );

      expect(argOf<object>(setLogs.upsert)).toMatchObject({
        where: {
          sessionId_exerciseIndex_setIndex: {
            sessionId: SESSION_ID,
            exerciseIndex: 1,
            setIndex: 2,
          },
        },
        create: {
          sessionId: SESSION_ID,
          exerciseIndex: 1,
          setIndex: 2,
          memberId: MEMBER,
          exerciseName: 'Shoulder press',
          exerciseSlug: 'shoulder-press',
          weightGrams: 22_250,
          reps: 8,
          completedAt: NOW,
        },
        update: { weightGrams: 22_250, reps: 8 },
      });
      expect(logged).toEqual({
        exerciseIndex: 1,
        setIndex: 2,
        weightKg: 22.25,
        reps: 8,
        completedAt: new Date(STARTED.getTime() + 20 * 60_000).toISOString(),
      });
    });

    it('stores bodyweight as null grams', async () => {
      await build().logSet(MEMBER, SESSION_ID, '2', '0', { weightKg: null, reps: 12 }, NOW);
      expect(
        argOf<{ create: { weightGrams: unknown } }>(setLogs.upsert).create.weightGrams,
      ).toBeNull();
    });
  });

  describe('unlogSet', () => {
    beforeEach(() => {
      raw.lock = [{ id: SESSION_ID, startedAt: STARTED, finishedAt: null, exercises: SNAPSHOT }];
    });

    it('deletes by key, and says false when there was nothing — replay-safe', async () => {
      await expect(build().unlogSet(MEMBER, SESSION_ID, '0', '1')).resolves.toEqual({
        deleted: true,
      });
      expect(argOf<object>(setLogs.deleteMany)).toEqual({
        where: { sessionId: SESSION_ID, exerciseIndex: 0, setIndex: 1 },
      });

      setLogs.deleteMany.mockResolvedValue({ count: 0 });
      await expect(build().unlogSet(MEMBER, SESSION_ID, '0', '1')).resolves.toEqual({
        deleted: false,
      });
    });

    it('404 missing, 409 finished, 400 bad index', async () => {
      await expect(build().unlogSet(MEMBER, SESSION_ID, '0', '99')).rejects.toMatchObject({
        code: 'WORKOUT_SET_INVALID',
      });
      raw.lock = [{ id: SESSION_ID, startedAt: STARTED, finishedAt: NOW, exercises: SNAPSHOT }];
      await expect(build().unlogSet(MEMBER, SESSION_ID, '0', '1')).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_FINISHED',
      });
      raw.lock = [];
      await expect(build().unlogSet(MEMBER, SESSION_ID, '0', '1')).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_MISSING',
      });
      expect(setLogs.deleteMany).not.toHaveBeenCalled();
    });
  });

  // ── Finish ───────────────────────────────────────────────────────────────

  describe('finish', () => {
    beforeEach(() => {
      raw.lock = [{ id: SESSION_ID, startedAt: STARTED, finishedAt: null, exercises: SNAPSHOT }];
      sessions.update.mockImplementation(({ data }: { data: Partial<SessionRow> }) =>
        Promise.resolve(sessionRow({ finishedAt: data.finishedAt, feeling: data.feeling ?? null })),
      );
    });

    it('refuses an empty workout — 422 WORKOUT_SESSION_EMPTY — and changes nothing', async () => {
      const caught = await failure(build().finish(MEMBER, SESSION_ID, {}, NOW));
      expect(caught).toMatchObject({ code: 'WORKOUT_SESSION_EMPTY' });
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(sessions.update).not.toHaveBeenCalled();
    });

    it('finishes now after a recent set, stores the feeling, and summarises against previous bests', async () => {
      setLogs.findMany.mockResolvedValue([
        setRow(0, 0, 10, { weightGrams: 85_000, reps: 10 }),
        setRow(0, 1, 45, { weightGrams: 80_000, reps: 12 }),
      ]);
      raw.best = [{ sessionId: SESSION_ID, slug: 'leg-press', bestGrams: 80_000 }];

      const summary = await build().finish(MEMBER, SESSION_ID, { feeling: 'HARD' }, NOW);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(argOf<object>(sessions.update)).toEqual({
        where: { id: SESSION_ID },
        data: { finishedAt: NOW, feeling: 'HARD' },
        select: expect.any(Object) as object,
      });
      expect(summary).toMatchObject({
        id: SESSION_ID,
        finishedAt: NOW.toISOString(),
        durationMinutes: 50,
        setsDone: 2,
        exercisesDone: 1,
        exerciseCount: 3,
        volumeKg: 85 * 10 + 80 * 12,
        bests: [{ exerciseName: 'Leg press', weightKg: 85, reps: 10, previousKg: 80 }],
        feeling: 'HARD',
      });
      // "Before this one": the best query is keyed on this session's start.
      expect(rawOf('best')[0].values).toContainEqual([
        STARTED.toISOString(),
        STARTED.toISOString(),
        STARTED.toISOString(),
      ]);
    });

    it('closes an idle session at its last set, not at now', async () => {
      const lastAt = new Date(NOW.getTime() - SESSION_IDLE_CLOSE_MS - 60_000);
      setLogs.findMany.mockResolvedValue([
        setRow(0, 0, 1, { completedAt: new Date(lastAt.getTime() - 60_000) }),
        setRow(0, 1, 2, { completedAt: lastAt }),
      ]);
      raw.lock = [
        {
          id: SESSION_ID,
          startedAt: new Date(lastAt.getTime() - 10 * 60_000),
          finishedAt: null,
          exercises: SNAPSHOT,
        },
      ];

      await build().finish(MEMBER, SESSION_ID, {}, NOW);

      expect(argOf<{ data: { finishedAt: Date } }>(sessions.update).data.finishedAt).toEqual(
        lastAt,
      );
    });

    it('answers a finished session with its summary again, changing nothing', async () => {
      raw.lock = [{ id: SESSION_ID, startedAt: STARTED, finishedAt: NOW, exercises: SNAPSHOT }];
      sessions.findFirst.mockResolvedValue({
        ...sessionRow({ finishedAt: NOW, feeling: 'EASY' }),
        sets: [setRow(0, 0, 5)],
      });

      const summary = await build().finish(MEMBER, SESSION_ID, { feeling: 'HARD' }, NOW);

      expect(sessions.update).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ id: SESSION_ID, setsDone: 1, feeling: 'EASY' });
    });

    it("404s a session that is not the caller's", async () => {
      raw.lock = [];
      await expect(build().finish(MEMBER, SESSION_ID, {}, NOW)).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_MISSING',
      });
    });

    it('logs counts and minutes only', async () => {
      setLogs.findMany.mockResolvedValue([setRow(0, 0, 10)]);
      await build().finish(MEMBER, SESSION_ID, {}, NOW);
      expect(logs.some((line) => /workout-session finished sets=1/.test(line))).toBe(true);
      expect(logs.join('\n')).not.toContain(MEMBER);
    });
  });

  // ── Feeling, discard ─────────────────────────────────────────────────────

  describe('patch', () => {
    it('sets the feeling on a finished session only, and returns its summary', async () => {
      sessions.findFirst.mockResolvedValue({
        ...sessionRow({ finishedAt: NOW, feeling: 'RIGHT' }),
        sets: [setRow(0, 0, 5)],
      });

      const summary = await build().patch(MEMBER, SESSION_ID, { feeling: 'RIGHT' });

      expect(argOf<object>(sessions.updateMany)).toEqual({
        where: { id: SESSION_ID, memberId: MEMBER, finishedAt: { not: null } },
        data: { feeling: 'RIGHT' },
      });
      expect(summary.feeling).toBe('RIGHT');
    });

    it('clears it with null', async () => {
      sessions.findFirst.mockResolvedValue({
        ...sessionRow({ finishedAt: NOW }),
        sets: [setRow(0, 0, 5)],
      });
      await build().patch(MEMBER, SESSION_ID, { feeling: null });
      expect(argOf<{ data: object }>(sessions.updateMany).data).toEqual({ feeling: null });
    });

    it('409 WORKOUT_SESSION_OPEN on an open session, 404 on a missing one', async () => {
      sessions.updateMany.mockResolvedValue({ count: 0 });
      sessions.findFirst.mockResolvedValueOnce({ id: SESSION_ID, finishedAt: null });
      const open = await failure(build().patch(MEMBER, SESSION_ID, { feeling: 'EASY' }));
      expect(open).toMatchObject({
        code: 'WORKOUT_SESSION_OPEN',
        details: { sessionId: SESSION_ID },
      });

      sessions.findFirst.mockResolvedValueOnce(null);
      await expect(build().patch(MEMBER, SESSION_ID, { feeling: 'EASY' })).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_MISSING',
      });
    });
  });

  describe('discard', () => {
    it('deletes an OPEN session of the caller (its sets cascade)', async () => {
      await expect(build().discard(MEMBER, SESSION_ID)).resolves.toEqual({ id: SESSION_ID });
      expect(argOf<object>(sessions.deleteMany)).toEqual({
        where: { id: SESSION_ID, memberId: MEMBER, finishedAt: null },
      });
      expect(logs.some((line) => /workout-session discarded/.test(line))).toBe(true);
    });

    it('409 WORKOUT_SESSION_FINISHED for a finished one, 404 for a missing one', async () => {
      sessions.deleteMany.mockResolvedValue({ count: 0 });
      sessions.findFirst.mockResolvedValueOnce({ id: SESSION_ID, finishedAt: NOW });
      await expect(build().discard(MEMBER, SESSION_ID)).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_FINISHED',
      });
      sessions.findFirst.mockResolvedValueOnce(null);
      await expect(build().discard(MEMBER, SESSION_ID)).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_MISSING',
      });
    });
  });

  // ── History ──────────────────────────────────────────────────────────────

  describe('list and summary', () => {
    const finished = (id: string, startedAt: Date, over: Partial<SessionRow> = {}) => ({
      ...sessionRow({
        id,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 40 * 60_000),
        ...over,
      }),
      sets: [setRow(0, 0, 5, { weightGrams: 90_000 })],
    });

    it('lists finished sessions newest first, with bests from ONE query for all of them', async () => {
      const newer = new Date('2026-09-29T01:00:00.000Z');
      const older = new Date('2026-09-27T01:00:00.000Z');
      sessions.findMany.mockResolvedValue([finished('s-new', newer), finished('s-old', older)]);
      raw.best = [
        { sessionId: 's-new', slug: 'leg-press', bestGrams: 85_000 },
        { sessionId: 's-old', slug: 'leg-press', bestGrams: 95_000 },
      ];

      const list = await build().list(MEMBER, 10);

      expect(argOf<object>(sessions.findMany)).toMatchObject({
        where: { memberId: MEMBER, finishedAt: { not: null } },
        orderBy: { startedAt: 'desc' },
        take: 10,
      });
      expect(list.map((s) => s.id)).toEqual(['s-new', 's-old']);
      expect(rawOf('best')).toHaveLength(1);
      // 90 kg beat 85 in the newer session, but not 95 in the older one.
      expect(list[0].bests).toEqual([
        { exerciseName: 'Leg press', weightKg: 90, reps: 10, previousKg: 85 },
      ]);
      expect(list[1].bests).toEqual([]);
    });

    it('caps the page at 50 and skips a session whose snapshot fails the shape', async () => {
      sessions.findMany.mockResolvedValue([
        finished('bad', new Date('2026-09-29T01:00:00.000Z'), { exercises: 'nope' }),
      ]);
      await expect(build().list(MEMBER, 500)).resolves.toEqual([]);
      expect(argOf<{ take: number }>(sessions.findMany).take).toBe(50);
      await build().list(MEMBER, Number.NaN);
      expect(argOf<{ take: number }>(sessions.findMany, 1).take).toBe(50);
    });

    it('summary: 404 missing, 409 WORKOUT_SESSION_OPEN while open, else the summary', async () => {
      await expect(build().summary(MEMBER, SESSION_ID)).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_MISSING',
      });
      sessions.findFirst.mockResolvedValueOnce({ ...sessionRow(), sets: [] });
      await expect(build().summary(MEMBER, SESSION_ID)).rejects.toMatchObject({
        code: 'WORKOUT_SESSION_OPEN',
      });
      sessions.findFirst.mockResolvedValueOnce(finished(SESSION_ID, STARTED));
      await expect(build().summary(MEMBER, SESSION_ID)).resolves.toMatchObject({
        id: SESSION_ID,
        durationMinutes: 40,
      });
    });
  });
});
