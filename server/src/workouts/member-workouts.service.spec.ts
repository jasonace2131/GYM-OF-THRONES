import { BadRequestException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ConfigService } from '@nestjs/config';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';
import type { GymConfigService } from '../config/gym.config';
import type { PrismaService } from '../prisma/prisma.service';
import { GeminiGateway } from '../assistant/gemini-gateway.service';
import type { WorkoutPlansService } from '../workout-plans/workout-plans.service';
import type { WorkoutQuotaService } from './workout-quota.service';
import type { WorkoutDraftService } from './workout-draft.service';
import type { WorkoutSessionsService } from './workout-sessions.service';
import { MEMBER_COPY } from './member-workout-gemini';
import { ADJUST_RESPONSE_SCHEMA, SWAP_RESPONSE_SCHEMA } from './member-plan-prompt';
import { MemberWorkoutsService } from './member-workouts.service';

jest.mock('@google/generative-ai', () => {
  const actual =
    jest.requireActual<typeof import('@google/generative-ai')>('@google/generative-ai');
  return { ...actual, GoogleGenerativeAI: jest.fn() };
});

/**
 * The member's plan library and the two paid tools (feat/member-workouts):
 * save a READY draft (five max, one active), rename, activate, hand-edit,
 * delete; Swap and Adjust charge before the call and refund on failure.
 */

const MEMBER = 'm0000000-0000-4000-8000-000000000001';
const PLAN_ID = 'p0000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-26T02:00:00.000Z');

const exercise = (name = 'Goblet squat') => ({
  name,
  muscles: 'Legs',
  sets: 3,
  reps: '10',
  restSeconds: 60,
});

const day = (weekday: number) => ({
  weekday,
  title: `Day ${weekday}`,
  focus: 'Full body',
  minutes: 45,
  warmUp: '5 min bike',
  coolDown: '3 min walk',
  exercises: [exercise(), exercise('Plank')],
});

const BODY = {
  summary: 'Two days.',
  days: [day(1), day(3)],
  guidance: [
    { title: 'Sleep', body: '7-9 hours.' },
    { title: 'Water', body: 'Drink up.' },
  ],
};

const INTAKE = {
  goal: 'MUSCLE',
  goalNotes: 'Bigger arms',
  experience: 'SOME',
  weekdays: [1, 3],
  sessionMinutes: 45,
  timeOfDay: 'EVENING',
  healthFlag: false,
  easyOn: ['KNEES'],
  use: { measurements: true, attendance: false, bookings: true },
};

const planRow = (over: Record<string, unknown> = {}) => ({
  id: PLAN_ID,
  name: 'Push pull',
  goal: 'MUSCLE',
  goalNotes: 'Bigger arms',
  experience: 'SOME',
  weekdays: [3, 1],
  sessionMinutes: 45,
  timeOfDay: 'EVENING',
  healthFlag: false,
  easyOn: ['KNEES'],
  useMeasurements: true,
  useAttendance: false,
  useBookings: true,
  body: BODY,
  source: 'AI',
  isActive: false,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const readyDraft = (over: Record<string, unknown> = {}) => ({
  memberId: MEMBER,
  jobId: 'job-1',
  status: 'READY',
  intake: INTAKE,
  plan: BODY,
  error: null,
  model: 'gemini-x',
  consentAt: NOW,
  startedAt: NOW,
  firstDayAt: NOW,
  finishedAt: NOW,
  ...over,
});

/** The coach's plan as the member reads it; "Monday" names a weekday, "Day 2" does not. */
const COACH_VIEW = {
  plan: {
    summary: 'Coach plan.',
    days: [
      { day: 'Monday', focus: 'Upper', exercises: [{ name: 'Bench press', sets: 3, reps: '8' }] },
      { day: 'Day 2', focus: 'Lower', exercises: [{ name: 'Squat', sets: 3, reps: '5' }] },
    ],
  },
  coach: { firstName: 'Ana', lastName: 'Reyes' },
  updatedAt: NOW.toISOString(),
};

/** The first argument of a mock's first call, typed by the caller. */
const arg0 = <T>(mock: jest.Mock): T => (mock.mock.calls[0] as [T])[0];

describe('MemberWorkoutsService', () => {
  let generateContent: jest.Mock;
  let getGenerativeModel: jest.Mock;
  let plans: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  let drafts: { findUnique: jest.Mock; deleteMany: jest.Mock };
  let prisma: {
    memberWorkoutPlan: typeof plans;
    memberWorkoutDraft: typeof drafts;
    user: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let quota: { charge: jest.Mock; refund: jest.Mock; view: jest.Mock };
  let draftService: { peek: jest.Mock };
  let coachPlans: { readForMember: jest.Mock };
  let sessions: { current: jest.Mock; list: jest.Mock };
  let logs: string[];

  const QUOTA = { used: 1, limit: 8, remaining: 7, resetsAt: 'x' };

  const build = (): MemberWorkoutsService => {
    const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;
    const gateway = new GeminiGateway(
      {
        get: (key: string) => (key === 'GEMINI_API_KEY' ? 'configured' : undefined),
      } as unknown as ConfigService<Env, true>,
      gym,
    );
    return new MemberWorkoutsService(
      prisma as unknown as PrismaService,
      quota as unknown as WorkoutQuotaService,
      draftService as unknown as WorkoutDraftService,
      gateway,
      coachPlans as unknown as WorkoutPlansService,
      sessions as unknown as WorkoutSessionsService,
    );
  };

  const reply = (value: unknown) => ({
    response: { text: () => JSON.stringify(value), candidates: [{ finishReason: 'STOP' }] },
  });

  const failure = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error('expected a failure');
      },
      (caught: unknown) => caught,
    );

  beforeEach(() => {
    generateContent = jest.fn();
    getGenerativeModel = jest.fn(() => ({ generateContent }));
    (GoogleGenerativeAI as unknown as jest.Mock).mockImplementation(() => ({
      getGenerativeModel,
    }));
    plans = {
      findMany: jest.fn().mockResolvedValue([planRow()]),
      findFirst: jest.fn().mockResolvedValue(planRow()),
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn().mockResolvedValue(planRow({ isActive: true })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    drafts = {
      findUnique: jest.fn().mockResolvedValue(readyDraft()),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    prisma = {
      memberWorkoutPlan: plans,
      memberWorkoutDraft: drafts,
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ medicalNotes: 'Bad left knee', shareMedicalWithPlanner: false }),
      },
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    quota = {
      charge: jest.fn().mockResolvedValue(QUOTA),
      refund: jest.fn().mockResolvedValue(undefined),
      view: jest.fn().mockResolvedValue({ used: 0, limit: 8, remaining: 8, resetsAt: 'x' }),
    };
    draftService = { peek: jest.fn().mockResolvedValue(null) };
    coachPlans = { readForMember: jest.fn().mockResolvedValue({ plan: null }) };
    sessions = {
      current: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
    };
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push(String(args[0]));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('home', () => {
    it('lists the plans newest first with the newest intake for the wizard', async () => {
      const older = planRow({
        id: 'older',
        goal: 'FAT_LOSS',
        createdAt: new Date(NOW.getTime() - 1),
      });
      plans.findMany.mockResolvedValue([planRow(), older]);

      const home = await build().home(MEMBER, NOW);

      expect(arg0<object>(plans.findMany)).toMatchObject({
        where: { memberId: MEMBER },
        orderBy: { createdAt: 'desc' },
      });
      expect(home.plans.map((p) => p.id)).toEqual([PLAN_ID, 'older']);
      expect(home.plans[0].intake).toEqual(INTAKE);
      expect(home.lastIntake).toEqual(INTAKE);
      expect(home.draft).toBeNull();
      expect(home.quota.remaining).toBe(8);
    });

    it('has null lastIntake with no plans, and skips a plan whose body fails the schema', async () => {
      plans.findMany.mockResolvedValue([]);
      expect((await build().home(MEMBER, NOW)).lastIntake).toBeNull();

      plans.findMany.mockResolvedValue([planRow({ body: { summary: 'x' } })]);
      const home = await build().home(MEMBER, NOW);
      expect(home.plans).toEqual([]);
      expect(logs.some((line) => /fails the plan schema/.test(line))).toBe(true);
    });

    it('has no coach plan, no open session and no history for a new member', async () => {
      const home = await build().home(MEMBER, NOW);
      expect(home).toMatchObject({ coachPlan: null, session: null, recent: [] });
      expect(coachPlans.readForMember).toHaveBeenCalledWith(MEMBER);
      expect(sessions.current).toHaveBeenCalledWith(MEMBER);
      expect(sessions.list).toHaveBeenCalledWith(MEMBER, 5);
    });

    it("shows the coach's plan with its weekdays, active only when no AI plan is", async () => {
      coachPlans.readForMember.mockResolvedValue({ plan: COACH_VIEW });

      plans.findMany.mockResolvedValue([planRow({ isActive: true })]);
      const behindAi = await build().home(MEMBER, NOW);
      expect(behindAi.coachPlan).toEqual({ ...COACH_VIEW, isActive: false, weekdays: [1, null] });

      plans.findMany.mockResolvedValue([planRow({ isActive: false })]);
      const driving = await build().home(MEMBER, NOW);
      expect(driving.coachPlan).toMatchObject({ isActive: true, weekdays: [1, null] });
    });

    it('carries the open session and the recent finished ones', async () => {
      sessions.current.mockResolvedValue({ id: 'open-session' });
      sessions.list.mockResolvedValue([{ id: 'done-1' }, { id: 'done-2' }]);
      const home = await build().home(MEMBER, NOW);
      expect(home.session).toEqual({ id: 'open-session' });
      expect(home.recent.map((s) => s.id)).toEqual(['done-1', 'done-2']);
    });
  });

  describe('useCoachPlan', () => {
    it("clears the member's active AI plan and answers the coach's plan as active", async () => {
      coachPlans.readForMember.mockResolvedValue({ plan: COACH_VIEW });

      const result = await build().useCoachPlan(MEMBER);

      expect(plans.updateMany).toHaveBeenCalledWith({
        where: { memberId: MEMBER, isActive: true },
        data: { isActive: false },
      });
      expect(result).toEqual({ ...COACH_VIEW, isActive: true, weekdays: [1, null] });
    });

    it("404 WORKOUT_DAY_UNKNOWN when there is no coach's plan, and changes nothing", async () => {
      const caught = await failure(build().useCoachPlan(MEMBER));
      expect(caught).toMatchObject({ code: 'WORKOUT_DAY_UNKNOWN' });
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(plans.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('save', () => {
    it('answers 404 WORKOUT_DRAFT_MISSING with no draft', async () => {
      drafts.findUnique.mockResolvedValue(null);
      const caught = await failure(build().save(MEMBER, { name: 'A', makeActive: true }, NOW));
      expect(caught).toMatchObject({ code: 'WORKOUT_DRAFT_MISSING' });
    });

    it('answers 409 WORKOUT_DRAFT_NOT_READY while running or failed', async () => {
      for (const status of ['RUNNING', 'FAILED']) {
        drafts.findUnique.mockResolvedValue(readyDraft({ status }));
        const caught = await failure(build().save(MEMBER, { name: 'A', makeActive: true }, NOW));
        expect(caught).toMatchObject({ code: 'WORKOUT_DRAFT_NOT_READY' });
        expect((caught as DomainException).getStatus()).toBe(HttpStatus.CONFLICT);
      }
      expect(plans.create).not.toHaveBeenCalled();
    });

    it('answers 409 WORKOUT_PLAN_LIMIT at five plans, with the member copy', async () => {
      plans.count.mockResolvedValue(5);
      const caught = await failure(build().save(MEMBER, { name: 'A', makeActive: false }, NOW));
      expect(caught).toMatchObject({
        code: 'WORKOUT_PLAN_LIMIT',
        message: 'You already keep 5 plans. Delete one to save this.',
      });
      expect(plans.create).not.toHaveBeenCalled();
    });

    it('creates the plan from the draft, makes it the only active one, and deletes the draft by jobId', async () => {
      const view = await build().save(MEMBER, { name: '  Push pull ', makeActive: true }, NOW);

      expect(plans.updateMany).toHaveBeenCalledWith({
        where: { memberId: MEMBER, isActive: true },
        data: { isActive: false },
      });
      const [create] = plans.create.mock.calls[0] as [{ data: Record<string, unknown> }];
      expect(create.data).toMatchObject({
        memberId: MEMBER,
        name: 'Push pull',
        goal: 'MUSCLE',
        goalNotes: 'Bigger arms',
        experience: 'SOME',
        weekdays: [1, 3],
        sessionMinutes: 45,
        timeOfDay: 'EVENING',
        healthFlag: false,
        easyOn: ['KNEES'],
        useMeasurements: true,
        useAttendance: false,
        useBookings: true,
        body: BODY,
        source: 'AI',
        model: 'gemini-x',
        isActive: true,
        consentAt: NOW,
      });
      expect(drafts.deleteMany).toHaveBeenCalledWith({
        where: { memberId: MEMBER, jobId: 'job-1' },
      });
      expect(view.isActive).toBe(true);
    });

    it('leaves the others alone when not made active', async () => {
      plans.create.mockResolvedValue(planRow());
      await build().save(MEMBER, { name: 'A', makeActive: false }, NOW);
      expect(plans.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('one plan', () => {
    it('reads by id AND member, and 404s an unscoped miss', async () => {
      await build().get(MEMBER, PLAN_ID);
      expect(arg0<object>(plans.findFirst)).toMatchObject({
        where: { id: PLAN_ID, memberId: MEMBER },
      });

      plans.findFirst.mockResolvedValue(null);
      await expect(build().get(MEMBER, PLAN_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch: activating clears the others in the same transaction', async () => {
      await build().patch(MEMBER, PLAN_ID, { isActive: true });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect((plans.updateMany.mock.calls[0] as [object])[0]).toEqual({
        where: { memberId: MEMBER, isActive: true, id: { not: PLAN_ID } },
        data: { isActive: false },
      });
      expect((plans.updateMany.mock.calls[1] as [object])[0]).toEqual({
        where: { id: PLAN_ID, memberId: MEMBER },
        data: { isActive: true },
      });
    });

    it('patch: renames, trimmed, and 404s a miss', async () => {
      await build().patch(MEMBER, PLAN_ID, { name: '  Legs  ' });
      expect((plans.updateMany.mock.calls[0] as [object])[0]).toEqual({
        where: { id: PLAN_ID, memberId: MEMBER },
        data: { name: 'Legs' },
      });

      plans.updateMany.mockResolvedValue({ count: 0 });
      await expect(build().patch(MEMBER, PLAN_ID, { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('putBody: rejects a broken plan with 400 WORKOUT_PLAN_INVALID and the error list', async () => {
      const caught = await failure(build().putBody(MEMBER, PLAN_ID, { summary: 'x', days: [] }));
      expect(caught).toMatchObject({ code: 'WORKOUT_PLAN_INVALID' });
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect((caught as DomainException).details).toMatchObject({
        errors: expect.arrayContaining([expect.stringMatching(/days must hold/)]) as string[],
      });
      expect(plans.updateMany).not.toHaveBeenCalled();
    });

    it('putBody: stores the normalised plan as EDITED', async () => {
      await build().putBody(MEMBER, PLAN_ID, { ...BODY, summary: '  Edited.  ' });
      expect((plans.updateMany.mock.calls[0] as [object])[0]).toMatchObject({
        where: { id: PLAN_ID, memberId: MEMBER },
        data: { body: { ...BODY, summary: 'Edited.' }, source: 'EDITED', model: null },
      });
    });

    it('remove: deletes by id and member, 404 on a miss', async () => {
      expect(await build().remove(MEMBER, PLAN_ID)).toEqual({ id: PLAN_ID });
      expect(plans.deleteMany).toHaveBeenCalledWith({ where: { id: PLAN_ID, memberId: MEMBER } });

      plans.deleteMany.mockResolvedValue({ count: 0 });
      await expect(build().remove(MEMBER, PLAN_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('swap', () => {
    const ALTERNATIVES = {
      alternatives: ['A', 'B', 'C'].map((name) => ({ ...exercise(name), why: 'Fits.' })),
    };

    it('404s an exercise that is not there, without charging', async () => {
      for (const body of [
        { weekday: 2, index: 0 },
        { weekday: 1, index: 2 },
      ]) {
        await expect(build().swap(MEMBER, PLAN_ID, body, NOW)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      }
      expect(quota.charge).not.toHaveBeenCalled();
    });

    it('charges first, asks with the schema and no personal facts, returns three', async () => {
      generateContent.mockResolvedValue(reply(ALTERNATIVES));

      const result = await build().swap(MEMBER, PLAN_ID, { weekday: 1, index: 1 }, NOW);

      expect(quota.charge).toHaveBeenCalledWith(prisma, MEMBER, NOW);
      const [params] = getGenerativeModel.mock.calls[0] as [
        { generationConfig: Record<string, unknown> },
      ];
      expect(params.generationConfig).toMatchObject({
        responseMimeType: 'application/json',
        responseSchema: SWAP_RESPONSE_SCHEMA,
      });
      const [prompt] = generateContent.mock.calls[0] as [string];
      expect(prompt).toContain('"name":"Plank"');
      expect(prompt).not.toContain('Bigger arms');
      expect(prompt).not.toContain(MEMBER);
      expect(result.alternatives).toHaveLength(3);
      expect(result.quota).toEqual(QUOTA);
      expect(quota.refund).not.toHaveBeenCalled();
    });

    it('sends the medical notes only when the member opted in', async () => {
      generateContent.mockResolvedValue(reply(ALTERNATIVES));
      await build().swap(MEMBER, PLAN_ID, { weekday: 1, index: 1 }, NOW);
      expect((generateContent.mock.calls[0] as [string])[0]).not.toContain('Bad left knee');

      prisma.user.findUnique.mockResolvedValue({
        medicalNotes: 'Bad left knee',
        shareMedicalWithPlanner: true,
      });
      await build().swap(MEMBER, PLAN_ID, { weekday: 1, index: 1 }, NOW);
      expect((generateContent.mock.calls[1] as [string])[0]).toContain(
        '"medicalNotes":"Bad left knee"',
      );
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: MEMBER },
        select: { medicalNotes: true, shareMedicalWithPlanner: true },
      });
    });

    it('refunds and says "could not use" when every model answers badly', async () => {
      generateContent.mockResolvedValue(reply({ alternatives: [exercise()] }));

      const caught = await failure(build().swap(MEMBER, PLAN_ID, { weekday: 1, index: 0 }, NOW));

      expect(caught).toMatchObject({
        code: 'WORKOUT_PLAN_SUGGESTION_INVALID',
        message: MEMBER_COPY.unusable,
      });
      expect(quota.refund).toHaveBeenCalledWith(MEMBER, NOW);
    });

    it('refunds when the gateway is busy', async () => {
      generateContent.mockRejectedValue(Object.assign(new Error('quota'), { status: 429 }));
      const caught = await failure(build().swap(MEMBER, PLAN_ID, { weekday: 1, index: 0 }, NOW));
      expect(caught).toMatchObject({ code: 'ASSISTANT_BUSY' });
      expect(quota.refund).toHaveBeenCalledTimes(1);
    });
  });

  describe('adjust', () => {
    it('needs exactly one of preset and request, before charging', async () => {
      for (const body of [{ weekday: 1 }, { weekday: 1, preset: 'SHORTER', request: 'x' }]) {
        await expect(
          build().adjust(MEMBER, PLAN_ID, body as { weekday: number }, NOW),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(quota.charge).not.toHaveBeenCalled();
    });

    it('404s a weekday the plan has no day for, without charging', async () => {
      await expect(
        build().adjust(MEMBER, PLAN_ID, { weekday: 2, preset: 'SHORTER' }, NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(quota.charge).not.toHaveBeenCalled();
    });

    it('returns the validated day for the same weekday', async () => {
      generateContent.mockResolvedValue(reply({ ...day(1), title: 'Shorter day' }));

      const result = await build().adjust(MEMBER, PLAN_ID, { weekday: 1, preset: 'SHORTER' }, NOW);

      const [params] = getGenerativeModel.mock.calls[0] as [
        { generationConfig: Record<string, unknown> },
      ];
      expect(params.generationConfig).toMatchObject({ responseSchema: ADJUST_RESPONSE_SCHEMA });
      const [prompt] = generateContent.mock.calls[0] as [string];
      expect(prompt).toMatch(/30 minutes/);
      expect(prompt).not.toContain('Bigger arms');
      expect(result.day.title).toBe('Shorter day');
      expect(result.quota).toEqual(QUOTA);
    });

    it('sends the medical notes only when the member opted in', async () => {
      generateContent.mockResolvedValue(reply(day(1)));
      await build().adjust(MEMBER, PLAN_ID, { weekday: 1, preset: 'SHORTER' }, NOW);
      expect((generateContent.mock.calls[0] as [string])[0]).not.toContain('Bad left knee');

      prisma.user.findUnique.mockResolvedValue({
        medicalNotes: 'Bad left knee',
        shareMedicalWithPlanner: true,
      });
      await build().adjust(MEMBER, PLAN_ID, { weekday: 1, preset: 'SHORTER' }, NOW);
      expect((generateContent.mock.calls[1] as [string])[0]).toContain(
        '"medicalNotes":"Bad left knee"',
      );
    });

    it('treats a day for another weekday as unusable, and refunds', async () => {
      generateContent.mockResolvedValue(reply(day(3)));

      const caught = await failure(
        build().adjust(MEMBER, PLAN_ID, { weekday: 1, request: 'More arms' }, NOW),
      );

      expect(caught).toMatchObject({ code: 'WORKOUT_PLAN_SUGGESTION_INVALID' });
      expect(quota.refund).toHaveBeenCalledWith(MEMBER, NOW);
      const [prompt] = generateContent.mock.calls[0] as [string];
      expect(prompt).toContain('"request":"More arms"');
    });
  });
});
