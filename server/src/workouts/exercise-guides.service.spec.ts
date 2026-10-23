import { Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ConfigService } from '@nestjs/config';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';
import type { GymConfigService } from '../config/gym.config';
import type { PrismaService } from '../prisma/prisma.service';
import type { MembershipService } from '../membership/membership.service';
import { GeminiGateway } from '../assistant/gemini-gateway.service';
import { GUIDE_RESPONSE_SCHEMA } from './member-plan-prompt';
import { ExerciseGuidesService, exerciseNamesOf } from './exercise-guides.service';

jest.mock('@google/generative-ai', () => {
  const actual =
    jest.requireActual<typeof import('@google/generative-ai')>('@google/generative-ai');
  return { ...actual, GoogleGenerativeAI: jest.fn() };
});

/**
 * "How to do it" (feat/member-workouts): free, cached, shared, and never a
 * general endpoint — the name must be in one of the caller's own plans or
 * their draft.
 */

const MEMBER = 'm0000000-0000-4000-8000-000000000001';
/** The caller as the controller passes it: a member acting on their own account. */
const CALLER = { id: MEMBER, role: 'CLIENT' as const };

const GUIDE = {
  steps: ['Hold the bell at your chest.', 'Sit between your heels.', 'Stand tall.'],
  mistake: 'Heels lifting — sit back more.',
  easier: 'Squat to a box.',
  harder: 'Pause two seconds at the bottom.',
};

const bodyWith = (...names: string[]) => ({
  summary: 's',
  days: [
    {
      weekday: 1,
      title: 't',
      focus: 'f',
      minutes: 45,
      warmUp: 'w',
      coolDown: 'c',
      exercises: names.map((name) => ({
        name,
        muscles: 'm',
        sets: 3,
        reps: '10',
        restSeconds: 60,
      })),
    },
  ],
  guidance: [],
});

describe('exerciseNamesOf', () => {
  it('walks days[].exercises[].name leniently', () => {
    expect(exerciseNamesOf(bodyWith('Goblet squat', ' Plank '))).toEqual(['goblet squat', 'plank']);
    expect(exerciseNamesOf({ days: [{ exercises: [{ name: 1 }, 'x'] }, null] })).toEqual([]);
    expect(exerciseNamesOf(null)).toEqual([]);
  });
});

describe('ExerciseGuidesService', () => {
  let generateContent: jest.Mock;
  let getGenerativeModel: jest.Mock;
  let guides: { findUnique: jest.Mock; upsert: jest.Mock };
  let plans: { findMany: jest.Mock };
  let drafts: { findUnique: jest.Mock };
  let coachPlans: { findUnique: jest.Mock };
  let sessions: { findFirst: jest.Mock };
  let logs: string[];
  let hasActiveMembership: jest.Mock;

  const build = (): ExerciseGuidesService => {
    const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;
    const gateway = new GeminiGateway(
      {
        get: (key: string) => (key === 'GEMINI_API_KEY' ? 'configured' : undefined),
      } as unknown as ConfigService<Env, true>,
      gym,
    );
    return new ExerciseGuidesService(
      {
        exerciseGuide: guides,
        memberWorkoutPlan: plans,
        memberWorkoutDraft: drafts,
        workoutPlan: coachPlans,
        workoutSession: sessions,
      } as unknown as PrismaService,
      gateway,
      { hasActiveMembership } as unknown as MembershipService,
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
    guides = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
    };
    plans = { findMany: jest.fn().mockResolvedValue([{ body: bodyWith('Goblet squat') }]) };
    drafts = { findUnique: jest.fn().mockResolvedValue({ plan: bodyWith('Plank') }) };
    coachPlans = { findUnique: jest.fn().mockResolvedValue(null) };
    sessions = { findFirst: jest.fn().mockResolvedValue(null) };
    logs = [];
    hasActiveMembership = jest.fn().mockResolvedValue(true);
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push(String(args[0]));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it("404s WORKOUT_EXERCISE_UNKNOWN for a name that is in none of the caller's plans or draft", async () => {
    for (const name of ['Deadlift', '', '   ', '???']) {
      const caught = await failure(build().guide(CALLER, name));
      expect(caught).toBeInstanceOf(DomainException);
      expect(caught).toMatchObject({ code: 'WORKOUT_EXERCISE_UNKNOWN' });
    }
    expect(generateContent).not.toHaveBeenCalled();
    expect(guides.findUnique).not.toHaveBeenCalled();
  });

  it('matches the name case-insensitively and trimmed, in a plan or in the draft', async () => {
    guides.findUnique.mockResolvedValue({ name: 'Goblet squat', body: GUIDE });
    await expect(build().guide(CALLER, '  goblet SQUAT ')).resolves.toMatchObject({
      steps: GUIDE.steps,
    });
    guides.findUnique.mockResolvedValue({ name: 'Plank', body: GUIDE });
    await expect(build().guide(CALLER, 'plank')).resolves.toMatchObject({ name: 'Plank' });
  });

  it("also accepts an exercise from the coach's plan (feat/workout-sessions)", async () => {
    coachPlans.findUnique.mockResolvedValue({
      body: {
        summary: 's',
        days: [
          { day: 'Monday', focus: 'f', exercises: [{ name: 'Bench press', sets: 3, reps: '8' }] },
        ],
      },
    });
    guides.findUnique.mockResolvedValue({ name: 'Bench press', body: GUIDE });

    await expect(build().guide(CALLER, 'bench PRESS')).resolves.toMatchObject({
      name: 'Bench press',
    });
    expect((coachPlans.findUnique.mock.calls[0] as [object])[0]).toMatchObject({
      where: { memberId: MEMBER },
    });
  });

  it("also accepts an exercise from the member's OPEN session's snapshot", async () => {
    sessions.findFirst.mockResolvedValue({
      exercises: [
        { name: 'Cable row', muscles: null, sets: 3, reps: '10', restSeconds: 90 },
        { name: 'Face pull', muscles: null, sets: 3, reps: '15', restSeconds: 60 },
      ],
    });
    guides.findUnique.mockResolvedValue({ name: 'Face pull', body: GUIDE });

    await expect(build().guide(CALLER, 'Face pull')).resolves.toMatchObject({ name: 'Face pull' });
    expect((sessions.findFirst.mock.calls[0] as [object])[0]).toMatchObject({
      where: { memberId: MEMBER, finishedAt: null },
    });
  });

  it('still 404s a name that is in none of the four', async () => {
    coachPlans.findUnique.mockResolvedValue({
      body: { summary: 's', days: [{ day: 'Mon', focus: 'f', exercises: [{ name: 'Dips' }] }] },
    });
    sessions.findFirst.mockResolvedValue({ exercises: [{ name: 'Cable row' }] });
    await expect(build().guide(CALLER, 'Deadlift')).rejects.toMatchObject({
      code: 'WORKOUT_EXERCISE_UNKNOWN',
    });
  });

  it('serves a cache hit without asking the model', async () => {
    guides.findUnique.mockResolvedValue({ name: 'Goblet squat', body: GUIDE });

    const view = await build().guide(CALLER, 'Goblet squat');

    expect(guides.findUnique).toHaveBeenCalledWith({ where: { slug: 'goblet-squat' } });
    expect(view).toEqual({ name: 'Goblet squat', ...GUIDE });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('asks with the exercise name only on a miss, stores it, and returns it', async () => {
    generateContent.mockResolvedValue(reply(GUIDE));

    const view = await build().guide(CALLER, 'Goblet squat');

    const [params] = getGenerativeModel.mock.calls[0] as [
      { generationConfig: Record<string, unknown> },
    ];
    expect(params.generationConfig).toMatchObject({ responseSchema: GUIDE_RESPONSE_SCHEMA });
    expect((generateContent.mock.calls[0] as [string])[0]).toBe('Exercise: "Goblet squat"');
    expect(guides.upsert).toHaveBeenCalledWith({
      where: { slug: 'goblet-squat' },
      create: {
        slug: 'goblet-squat',
        name: 'Goblet squat',
        body: GUIDE,
        model: 'gemini-3.1-flash-lite',
      },
      update: {},
    });
    expect(view).toEqual({ name: 'Goblet squat', ...GUIDE });
  });

  it('rotates past an unusable reply and gives up with the member copy', async () => {
    generateContent.mockResolvedValue(reply({ steps: ['a'] }));
    const caught = await failure(build().guide(CALLER, 'Goblet squat'));
    expect(caught).toMatchObject({ code: 'WORKOUT_PLAN_SUGGESTION_INVALID' });
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(guides.upsert).not.toHaveBeenCalled();
  });

  it('treats a cached row that no longer parses as a miss', async () => {
    guides.findUnique.mockResolvedValue({ name: 'Goblet squat', body: { steps: [] } });
    generateContent.mockResolvedValue(reply(GUIDE));
    await build().guide(CALLER, 'Goblet squat');
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  // Owner, 2026-10-17: a lapsed member keeps "How to" for what is already
  // cached — it costs nothing — but a miss would spend Gemini, so only an
  // ACTIVE member (or staff) may cause one.
  describe('the membership gate, on the miss only', () => {
    it('serves a cached guide to a lapsed member, never asking about the membership', async () => {
      hasActiveMembership.mockResolvedValue(false);
      guides.findUnique.mockResolvedValue({ name: 'Goblet squat', body: GUIDE });

      await expect(build().guide(CALLER, 'Goblet squat')).resolves.toEqual({
        name: 'Goblet squat',
        ...GUIDE,
      });
      expect(generateContent).not.toHaveBeenCalled();
    });

    it('refuses a lapsed member a miss with 403 MEMBERSHIP_REQUIRED before any Gemini call', async () => {
      hasActiveMembership.mockResolvedValue(false);

      const caught = await failure(build().guide(CALLER, 'Goblet squat'));

      expect(caught).toBeInstanceOf(DomainException);
      expect(caught).toMatchObject({ code: 'MEMBERSHIP_REQUIRED' });
      expect((caught as DomainException).getStatus()).toBe(403);
      expect(hasActiveMembership).toHaveBeenCalledWith(MEMBER);
      expect(generateContent).not.toHaveBeenCalled();
      expect(guides.upsert).not.toHaveBeenCalled();
    });

    it('generates a miss for an active member', async () => {
      generateContent.mockResolvedValue(reply(GUIDE));
      await expect(build().guide(CALLER, 'Goblet squat')).resolves.toMatchObject({
        name: 'Goblet squat',
      });
      expect(generateContent).toHaveBeenCalledTimes(1);
    });

    it('generates a miss for staff without asking about a membership', async () => {
      hasActiveMembership.mockResolvedValue(false);
      generateContent.mockResolvedValue(reply(GUIDE));
      await expect(
        build().guide({ id: MEMBER, role: 'COACH' }, 'Goblet squat'),
      ).resolves.toMatchObject({ name: 'Goblet squat' });
      expect(hasActiveMembership).not.toHaveBeenCalled();
      expect(generateContent).toHaveBeenCalledTimes(1);
    });
  });
});
