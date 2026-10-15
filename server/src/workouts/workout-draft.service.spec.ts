import { BadRequestException, HttpStatus, Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ConfigService } from '@nestjs/config';
import { WORKOUT_DRAFT_STALE_MS } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';
import type { GymConfigService } from '../config/gym.config';
import type { OpeningHoursService } from '../config/opening-hours.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProgressService } from '../me/progress.service';
import type { MeCheckInsService } from '../me/me-check-ins.service';
import type { BookingsService } from '../classes/bookings.service';
import { GeminiGateway } from '../assistant/gemini-gateway.service';
import type { WorkoutQuotaService } from './workout-quota.service';
import { MEMBER_COPY } from './member-workout-gemini';
import { EMPTY_PLAN } from './workouts.presenter';
import { WorkoutDraftService } from './workout-draft.service';

jest.mock('@google/generative-ai', () => {
  const actual =
    jest.requireActual<typeof import('@google/generative-ai')>('@google/generative-ai');
  return { ...actual, GoogleGenerativeAI: jest.fn() };
});

/**
 * The generation job (feat/member-workouts): the draft IS the job. Charge,
 * create, stream, write each line under (memberId, jobId), stamp the first
 * day, finish READY — or FAILED with member copy and a refund. A cancelled
 * draft stops the job dead; a stale one is failed by the next read.
 */

const MEMBER = 'm0000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-26T02:00:00.000Z');

const intake = (over: Record<string, unknown> = {}) => ({
  goal: 'MUSCLE',
  goalNotes: 'Bigger arms',
  experience: 'SOME',
  weekdays: [1, 3],
  sessionMinutes: 45,
  timeOfDay: 'EVENING',
  healthFlag: false,
  easyOn: [],
  use: { measurements: true, attendance: true, bookings: true },
  consent: true,
  ...over,
});

const day = (weekday: number) => ({
  weekday,
  title: `Day ${weekday}`,
  focus: 'Full body',
  minutes: 45,
  warmUp: '5 min bike',
  coolDown: '3 min walk',
  exercises: [{ name: 'Goblet squat', muscles: 'Legs', sets: 3, reps: '10', restSeconds: 60 }],
});

const GUIDANCE = [
  { title: 'Sleep', body: '7-9 hours.' },
  { title: 'Water', body: 'Drink up.' },
];

const GOOD_LINES = [
  '{"summary":"Two full-body days."}',
  `{"day":${JSON.stringify(day(1))}}`,
  `{"day":${JSON.stringify(day(3))}}`,
  `{"guidance":${JSON.stringify(GUIDANCE)}}`,
];

/** A stream that hands the text over in arbitrary chunks, like the SDK does. */
const streamOf = (text: string, chunkSize = 17) => ({
  stream: (async function* () {
    for (let i = 0; i < text.length; i += chunkSize) {
      const piece = text.slice(i, i + chunkSize);
      await Promise.resolve();
      yield { text: () => piece };
    }
  })(),
  response: Promise.resolve({ text: () => text }),
});

describe('WorkoutDraftService', () => {
  let generateContentStream: jest.Mock;
  let getGenerativeModel: jest.Mock;
  let draft: {
    findUnique: jest.Mock;
    createMany: jest.Mock;
    deleteMany: jest.Mock;
    updateMany: jest.Mock;
  };
  let prisma: { memberWorkoutDraft: typeof draft; $transaction: jest.Mock };
  let quota: { charge: jest.Mock; refund: jest.Mock; view: jest.Mock };
  let logs: string[];

  const build = (apiKey: string | null = 'configured'): WorkoutDraftService => {
    const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;
    const gateway = new GeminiGateway(
      {
        get: (key: string) => (key === 'GEMINI_API_KEY' ? (apiKey ?? undefined) : undefined),
      } as unknown as ConfigService<Env, true>,
      gym,
    );
    return new WorkoutDraftService(
      prisma as unknown as PrismaService,
      gym,
      quota as unknown as WorkoutQuotaService,
      {
        summary: jest.fn().mockResolvedValue({
          measurements: [],
          goals: [],
          latestWeightGrams: 70_000,
          changeGrams: null,
          changeOverDays: null,
          bmiThousandths: null,
          coach: null,
        }),
      } as unknown as ProgressService,
      {
        summary: jest.fn().mockResolvedValue({
          thisMonth: 1,
          allTime: 1,
          avgPerWeek: 1,
          currentStreakWeeks: 1,
          longestStreakWeeks: 1,
          days: [],
        }),
      } as unknown as MeCheckInsService,
      { mine: jest.fn().mockResolvedValue([]) } as unknown as BookingsService,
      { week: jest.fn().mockResolvedValue([]) } as unknown as OpeningHoursService,
      gateway,
    );
  };

  const failure = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error('expected a failure');
      },
      (caught: unknown) => caught,
    );

  /** Every updateMany call's `data`, in order. */
  const writes = (): Record<string, unknown>[] =>
    draft.updateMany.mock.calls.map((call: [{ data: Record<string, unknown> }]) => call[0].data);

  beforeEach(() => {
    generateContentStream = jest.fn();
    getGenerativeModel = jest.fn(() => ({ generateContentStream }));
    (GoogleGenerativeAI as unknown as jest.Mock).mockImplementation(() => ({
      getGenerativeModel,
    }));
    draft = {
      findUnique: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    prisma = {
      memberWorkoutDraft: draft,
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    quota = {
      charge: jest.fn().mockResolvedValue({ used: 1, limit: 8, remaining: 7, resetsAt: 'x' }),
      refund: jest.fn().mockResolvedValue(undefined),
      view: jest.fn().mockResolvedValue({ used: 0, limit: 8, remaining: 8, resetsAt: 'x' }),
    };
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push(String(args[0]));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('start', () => {
    it('refuses without consent, before anything else', async () => {
      const service = build();
      const caught = await failure(
        service.start(MEMBER, intake({ consent: false, goal: 'nope' }), NOW),
      );
      expect(caught).toMatchObject({ code: 'WORKOUT_CONSENT_REQUIRED' });
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(quota.charge).not.toHaveBeenCalled();
    });

    it('rejects an intake that fails the shared rules as a 400', async () => {
      const caught = await failure(build().start(MEMBER, intake({ weekdays: [1, 1] }), NOW));
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(quota.charge).not.toHaveBeenCalled();
    });

    it('answers 409 WORKOUT_DRAFT_RUNNING while a job is running, without charging', async () => {
      draft.findUnique.mockResolvedValue({ status: 'RUNNING', jobId: 'j', startedAt: NOW });
      const caught = await failure(build().start(MEMBER, intake(), NOW));
      expect(caught).toMatchObject({ code: 'WORKOUT_DRAFT_RUNNING' });
      expect(quota.charge).not.toHaveBeenCalled();
    });

    it('charges, replaces the old draft, creates a RUNNING one and launches the job unawaited', async () => {
      const service = build();
      const run = jest.spyOn(service, 'run').mockReturnValue(new Promise(() => undefined));

      const result = await service.start(MEMBER, intake(), NOW);

      expect(quota.charge).toHaveBeenCalledWith(prisma, MEMBER, NOW);
      expect(draft.deleteMany).toHaveBeenCalledWith({
        where: { memberId: MEMBER, status: { not: 'RUNNING' } },
      });
      const [create] = draft.createMany.mock.calls[0] as [
        { data: [Record<string, unknown>]; skipDuplicates: boolean },
      ];
      expect(create.skipDuplicates).toBe(true);
      expect(create.data[0]).toMatchObject({
        memberId: MEMBER,
        status: 'RUNNING',
        plan: EMPTY_PLAN,
        consentAt: NOW,
        startedAt: NOW,
      });
      expect(create.data[0]['intake']).not.toHaveProperty('consent');
      expect(create.data[0]['intake']).toMatchObject({ goal: 'MUSCLE', weekdays: [1, 3] });

      expect(result.quota.remaining).toBe(7);
      expect(result.draft).toMatchObject({
        status: 'RUNNING',
        plan: EMPTY_PLAN,
        error: null,
        firstDayMs: null,
        startedAt: NOW.toISOString(),
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0]).toBe(MEMBER);
      expect(run.mock.calls[0][1]).toBe(create.data[0]['jobId']);
    });

    it('rolls back to 409 when another request created the running draft first', async () => {
      draft.createMany.mockResolvedValue({ count: 0 });
      const service = build();
      const run = jest.spyOn(service, 'run');
      const caught = await failure(service.start(MEMBER, intake(), NOW));
      expect(caught).toMatchObject({ code: 'WORKOUT_DRAFT_RUNNING' });
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe('run', () => {
    // A real instant just before the job runs: firstDayMs is measured against the clock.
    const STARTED = new Date(Date.now() - 1_000);

    const parsedIntake = (): Parameters<WorkoutDraftService['run']>[2] =>
      intake() as unknown as Parameters<WorkoutDraftService['run']>[2];

    it('streams the lines into the draft, stamps the first day, finishes READY', async () => {
      generateContentStream.mockResolvedValue(streamOf(GOOD_LINES.join('\n') + '\n'));

      await build().run(MEMBER, 'job-1', parsedIntake(), STARTED);

      for (const call of draft.updateMany.mock.calls as [{ where: unknown }][]) {
        expect(call[0].where).toEqual({ memberId: MEMBER, jobId: 'job-1' });
      }
      const data = writes();
      // reset, summary, day 1 (+ firstDayAt), day 3, guidance, READY
      expect(data).toHaveLength(6);
      expect(data[0]).toEqual({ plan: EMPTY_PLAN, firstDayAt: null });
      expect(data[1]).toEqual({
        plan: { summary: 'Two full-body days.', days: [], guidance: null },
      });
      expect(data[2]).toMatchObject({ plan: { days: [day(1)] } });
      expect(data[2]['firstDayAt']).toBeInstanceOf(Date);
      expect(data[3]).toMatchObject({ plan: { days: [day(1), day(3)] } });
      expect(data[3]).not.toHaveProperty('firstDayAt');
      expect(data[4]).toMatchObject({ plan: { guidance: GUIDANCE } });
      expect(data[5]).toMatchObject({
        status: 'READY',
        model: 'gemini-3.1-flash-lite',
        plan: { summary: 'Two full-body days.', days: [day(1), day(3)], guidance: GUIDANCE },
      });
      expect(data[5]['finishedAt']).toBeInstanceOf(Date);

      expect(logs.some((line) => /^member-workout first day ms=\d+ model=/.test(line))).toBe(true);
      expect(quota.refund).not.toHaveBeenCalled();
      const [, options] = generateContentStream.mock.calls[0] as [string, { timeout: number }];
      expect(typeof options.timeout).toBe('number');
    });

    it('sends nothing that identifies the member', async () => {
      generateContentStream.mockResolvedValue(streamOf(GOOD_LINES.join('\n')));
      await build().run(MEMBER, 'job-1', parsedIntake(), STARTED);
      const [prompt] = generateContentStream.mock.calls[0] as [string];
      expect(prompt).not.toContain(MEMBER);
      expect(prompt).toContain('"goalNotes":"Bigger arms"');
    });

    it('resets the partial plan and rotates to the next model after a bad line', async () => {
      generateContentStream
        .mockResolvedValueOnce(streamOf('{"summary":"ok"}\nHere is your plan:\n'))
        .mockResolvedValueOnce(streamOf(GOOD_LINES.join('\n')));

      await build().run(MEMBER, 'job-1', parsedIntake(), STARTED);

      const data = writes();
      expect(data[0]).toEqual({ plan: EMPTY_PLAN, firstDayAt: null });
      expect(data[1]).toMatchObject({ plan: { summary: 'ok' } });
      // The second attempt starts from nothing.
      expect(data[2]).toEqual({ plan: EMPTY_PLAN, firstDayAt: null });
      expect(data[data.length - 1]).toMatchObject({
        status: 'READY',
        model: 'gemini-2.5-flash-lite',
      });
      expect(quota.refund).not.toHaveBeenCalled();
    });

    it('treats a day for a weekday the member did not choose as unusable', async () => {
      generateContentStream.mockResolvedValue(
        streamOf(`{"summary":"x"}\n{"day":${JSON.stringify(day(5))}}\n`),
      );

      await build().run(MEMBER, 'job-1', parsedIntake(), STARTED);

      expect(writes().at(-1)).toMatchObject({ status: 'FAILED', error: MEMBER_COPY.unusable });
      expect(quota.refund).toHaveBeenCalledWith(MEMBER, STARTED);
      expect(generateContentStream).toHaveBeenCalledTimes(3);
    });

    it('fails with the timeout copy and refunds when the stream is cut off', async () => {
      generateContentStream.mockRejectedValue(
        Object.assign(new Error('Request aborted when fetching'), { name: 'AbortError' }),
      );

      await build().run(MEMBER, 'job-1', parsedIntake(), STARTED);

      expect(writes().at(-1)).toMatchObject({ status: 'FAILED', error: MEMBER_COPY.timeout });
      expect(quota.refund).toHaveBeenCalledTimes(1);
      expect(logs.some((line) => /member-workout failed/.test(line))).toBe(true);
    });

    it('stops quietly when the draft was cancelled mid-stream — no FAILED, no refund', async () => {
      generateContentStream.mockResolvedValue(streamOf(GOOD_LINES.join('\n')));
      draft.updateMany
        .mockResolvedValueOnce({ count: 1 }) // reset
        .mockResolvedValueOnce({ count: 1 }) // summary
        .mockResolvedValue({ count: 0 }); // the member pressed Cancel

      await build().run(MEMBER, 'job-1', parsedIntake(), STARTED);

      expect(writes().some((data) => data['status'] === 'FAILED')).toBe(false);
      expect(quota.refund).not.toHaveBeenCalled();
      expect(generateContentStream).toHaveBeenCalledTimes(1);
    });

    it('does not refund a cancelled draft even when the model then fails', async () => {
      generateContentStream.mockRejectedValue(
        Object.assign(new Error('Request aborted when fetching'), { name: 'AbortError' }),
      );
      draft.updateMany.mockResolvedValue({ count: 0 });

      await build().run(MEMBER, 'job-1', parsedIntake(), STARTED);

      expect(quota.refund).not.toHaveBeenCalled();
    });

    it("never logs the model's text", async () => {
      generateContentStream.mockResolvedValue(streamOf(GOOD_LINES.join('\n')));
      await build().run(MEMBER, 'job-1', parsedIntake(), STARTED);
      expect(logs.join('\n')).not.toContain('Goblet');
      expect(logs.join('\n')).not.toContain('Bigger arms');
    });
  });

  describe('read', () => {
    it('answers 404 WORKOUT_DRAFT_MISSING when there is none', async () => {
      const caught = await failure(build().read(MEMBER, NOW));
      expect(caught).toBeInstanceOf(DomainException);
      expect(caught).toMatchObject({ code: 'WORKOUT_DRAFT_MISSING' });
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.NOT_FOUND);
    });

    it('returns a fresh RUNNING draft with firstDayMs', async () => {
      draft.findUnique.mockResolvedValue({
        memberId: MEMBER,
        jobId: 'job-1',
        status: 'RUNNING',
        intake: { goal: 'MUSCLE' },
        plan: { summary: 's', days: [day(1)], guidance: null },
        error: null,
        model: null,
        startedAt: new Date(NOW.getTime() - 10_000),
        firstDayAt: new Date(NOW.getTime() - 7_200),
        finishedAt: null,
      });

      const view = await build().read(MEMBER, NOW);

      expect(view).toMatchObject({ status: 'RUNNING', firstDayMs: 2_800, error: null });
      expect(view.plan.days).toEqual([day(1)]);
      expect(draft.updateMany).not.toHaveBeenCalled();
    });

    it('fails a stale RUNNING draft, refunds, and returns it FAILED', async () => {
      const startedAt = new Date(NOW.getTime() - WORKOUT_DRAFT_STALE_MS - 1);
      draft.findUnique.mockResolvedValue({
        memberId: MEMBER,
        jobId: 'job-1',
        status: 'RUNNING',
        intake: {},
        plan: EMPTY_PLAN,
        error: null,
        model: null,
        startedAt,
        firstDayAt: null,
        finishedAt: null,
      });

      const view = await build().read(MEMBER, NOW);

      expect(draft.updateMany).toHaveBeenCalledWith({
        where: { memberId: MEMBER, jobId: 'job-1', status: 'RUNNING' },
        data: { status: 'FAILED', error: MEMBER_COPY.timeout, finishedAt: NOW },
      });
      expect(quota.refund).toHaveBeenCalledWith(MEMBER, startedAt);
      expect(view).toMatchObject({ status: 'FAILED', error: MEMBER_COPY.timeout });
    });
  });

  describe('cancel', () => {
    it('deletes the row and refunds nothing', async () => {
      draft.deleteMany.mockResolvedValue({ count: 1 });
      expect(await build().cancel(MEMBER)).toEqual({ cancelled: true });
      expect(draft.deleteMany).toHaveBeenCalledWith({ where: { memberId: MEMBER } });
      expect(quota.refund).not.toHaveBeenCalled();
    });
  });
});
