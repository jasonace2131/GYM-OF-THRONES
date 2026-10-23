import { Logger, NotFoundException } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { DomainException } from '../common/exceptions/domain.exception';
import { asCivilDate } from '../common/time/gym-time';
import type { Env } from '../config/env.validation';
import type { GymConfigService } from '../config/gym.config';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { ProgressService, CoachMemberProgress } from '../me/progress.service';
import type { MeCheckInsService } from '../me/me-check-ins.service';
import type { ScopedWhere } from '../rbac/scope.util';
import { GeminiGateway } from '../assistant/gemini-gateway.service';
import { WORKOUT_PLAN_RESPONSE_SCHEMA } from './workout-plan-prompt';
import type { GymEquipmentService } from '../gym-equipment/gym-equipment.service';
import { WorkoutPlansService, type PlanActor } from './workout-plans.service';

jest.mock('@google/generative-ai', () => {
  const actual =
    jest.requireActual<typeof import('@google/generative-ai')>('@google/generative-ai');
  return { ...actual, GoogleGenerativeAI: jest.fn() };
});

const NOW = new Date('2026-09-25T02:00:00.000Z');
const COACH: PlanActor = { id: 'c0000000-0000-4000-8000-000000000001', role: 'COACH' };
const MEMBER_ID = 'm0000000-0000-4000-8000-000000000001';
const scope = {
  assignedCoach: { some: { coachId: COACH.id, endedAt: null } },
} as unknown as ScopedWhere<Prisma.UserWhereInput>;

const PLAN = {
  summary: 'Three full-body days.',
  days: [
    {
      day: 'Monday',
      focus: 'Full body',
      exercises: [{ name: 'SECRET-EXERCISE-Squat', sets: 3, reps: '8-10' }],
    },
  ],
};

const memberProgress = (): CoachMemberProgress => ({
  member: { id: MEMBER_ID, firstName: 'Maria', lastName: 'Santos', memberCode: 'K7Q2PX' },
  measurements: [],
  goals: [
    {
      id: 'g1',
      name: 'SECRET-GOAL-Bench 60kg',
      unit: 'kg',
      startHundredths: 4_000,
      currentHundredths: 5_000,
      targetHundredths: 6_000,
      percent: 50,
      achievedAt: null,
      recordedBy: { firstName: 'Ana' },
      updatedBy: null,
    },
  ],
  latestWeightGrams: null,
  changeGrams: null,
  changeOverDays: null,
  bmiThousandths: null,
  coach: { firstName: 'Ana', lastName: 'Reyes' },
});

describe('WorkoutPlansService', () => {
  let generateContent: jest.Mock;
  let getGenerativeModel: jest.Mock;
  let prisma: {
    user: { findFirst: jest.Mock; findUnique: jest.Mock };
    workoutPlan: { findUnique: jest.Mock; upsert: jest.Mock };
  };
  let progress: { memberProgress: jest.Mock };
  let audit: { record: jest.Mock };
  let logs: string[];
  let equipment: { forPrompt: jest.Mock };

  const build = (apiKey: string | null = 'configured'): WorkoutPlansService => {
    const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;
    const gateway = new GeminiGateway(
      {
        get: (key: string) => (key === 'GEMINI_API_KEY' ? (apiKey ?? undefined) : undefined),
      } as unknown as ConfigService<Env, true>,
      gym,
    );
    return new WorkoutPlansService(
      prisma as unknown as PrismaService,
      gym,
      audit as unknown as AuditService,
      progress as unknown as ProgressService,
      {
        summary: jest.fn().mockResolvedValue({
          thisMonth: 3,
          allTime: 10,
          avgPerWeek: 2,
          currentStreakWeeks: 1,
          longestStreakWeeks: 2,
          days: [{ date: asCivilDate('2026-09-20'), count: 1 }],
        }),
      } as unknown as MeCheckInsService,
      gateway,
      equipment as unknown as GymEquipmentService,
    );
  };

  const reply = (text: string) => ({
    response: { text: () => text, candidates: [{ finishReason: 'STOP' }] },
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
    prisma = {
      user: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: MEMBER_ID, firstName: 'Maria', lastName: 'Santos' }),
        findUnique: jest.fn().mockResolvedValue({ heightCm: 182 }),
      },
      workoutPlan: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({
          id: 'plan-1',
          body: PLAN,
          updatedAt: NOW,
          coach: { firstName: 'Ana', lastName: 'Reyes', deletedAt: null },
        }),
      },
    };
    progress = { memberProgress: jest.fn().mockResolvedValue(memberProgress()) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    logs = [];
    equipment = { forPrompt: jest.fn().mockResolvedValue([]) };
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push(String(args[0]));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('suggest', () => {
    it('checks the scope before anything else, even with the AI switched off', async () => {
      progress.memberProgress.mockRejectedValue(new NotFoundException('Member not found'));

      await expect(build(null).suggest(COACH, MEMBER_ID, scope, NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(getGenerativeModel).not.toHaveBeenCalled();
    });

    it('answers ASSISTANT_NOT_CONFIGURED with the coach-facing copy when there is no key', async () => {
      const caught = await failure(build(null).suggest(COACH, MEMBER_ID, scope, NOW));
      expect(caught).toMatchObject({ code: 'ASSISTANT_NOT_CONFIGURED' });
      expect((caught as DomainException).message).toMatch(/write the plan yourself/);
    });

    it('makes ONE structured call with no tools, and returns the validated draft unsaved', async () => {
      generateContent.mockResolvedValue(reply(JSON.stringify(PLAN)));

      const result = await build().suggest(COACH, MEMBER_ID, scope, NOW);

      expect(result).toEqual({ draft: PLAN });
      expect(generateContent).toHaveBeenCalledTimes(1);
      const [params] = getGenerativeModel.mock.calls[0] as [
        { tools?: unknown; generationConfig: Record<string, unknown> },
      ];
      expect(params.tools).toBeUndefined();
      expect(params.generationConfig).toMatchObject({
        responseMimeType: 'application/json',
        responseSchema: WORKOUT_PLAN_RESPONSE_SCHEMA,
      });
      expect(prisma.workoutPlan.upsert).not.toHaveBeenCalled();
    });

    it("sends the member's own account height", async () => {
      generateContent.mockResolvedValue(reply(JSON.stringify(PLAN)));

      await build().suggest(COACH, MEMBER_ID, scope, NOW);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: MEMBER_ID },
        select: { heightCm: true },
      });
      const [prompt] = generateContent.mock.calls[0] as [string];
      expect(prompt).toContain('"heightCm":182');
    });

    it("sends the gym's equipment list as data", async () => {
      generateContent.mockResolvedValue(reply(JSON.stringify(PLAN)));
      equipment.forPrompt.mockResolvedValue(['Rower']);

      await build().suggest(COACH, MEMBER_ID, scope, NOW);

      const [prompt] = generateContent.mock.calls[0] as [string];
      expect(prompt).toContain('"gymEquipment":["Rower"]');
    });

    it('sends the model no name, member code or id', async () => {
      generateContent.mockResolvedValue(reply(JSON.stringify(PLAN)));

      await build().suggest(COACH, MEMBER_ID, scope, NOW);

      const [prompt] = generateContent.mock.calls[0] as [string];
      for (const secret of ['Maria', 'Santos', 'K7Q2PX', MEMBER_ID]) {
        expect(prompt).not.toContain(secret);
      }
    });

    it('refuses a reply that is not a plan with WORKOUT_PLAN_SUGGESTION_INVALID (502)', async () => {
      generateContent.mockResolvedValue(reply('{"summary":"x","days":[]}'));

      const caught = await failure(build().suggest(COACH, MEMBER_ID, scope, NOW));

      expect(caught).toMatchObject({ code: 'WORKOUT_PLAN_SUGGESTION_INVALID' });
      expect((caught as DomainException).getStatus()).toBe(502);
    });

    it('logs counts only — never a goal, an exercise or a name', async () => {
      generateContent.mockResolvedValue(reply(JSON.stringify(PLAN)));

      await build().suggest(COACH, MEMBER_ID, scope, NOW);

      const all = logs.join('\n');
      expect(all).toContain('workout-plan suggested');
      expect(all).toContain('days=1 exercises=1');
      for (const secret of ['SECRET-GOAL', 'SECRET-EXERCISE', 'Maria', 'Santos']) {
        expect(all).not.toContain(secret);
      }
    });
  });

  describe('save', () => {
    it('refuses the caller themselves with 404', async () => {
      await expect(build().save(COACH, COACH.id, scope, PLAN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses a member outside the scope with 404', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(build().save(COACH, MEMBER_ID, scope, PLAN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { AND: [{ id: MEMBER_ID }, scope] },
        select: { id: true, firstName: true, lastName: true },
      });
    });

    it('refuses an invalid plan with WORKOUT_PLAN_INVALID and every error in details', async () => {
      const caught = await failure(
        build().save(COACH, MEMBER_ID, scope, { summary: '', days: [] }),
      );
      expect(caught).toMatchObject({ code: 'WORKOUT_PLAN_INVALID' });
      expect((caught as DomainException).getStatus()).toBe(422);
      expect((caught as DomainException).details).toEqual({
        errors: ['summary must be 1-600 characters.', 'days must hold 1-7 days.'],
      });
      expect(prisma.workoutPlan.upsert).not.toHaveBeenCalled();
    });

    it('replaces the one plan per member and audits counts, not content', async () => {
      const view = await build().save(COACH, MEMBER_ID, scope, PLAN);

      expect(prisma.workoutPlan.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { memberId: MEMBER_ID },
          create: expect.objectContaining({
            memberId: MEMBER_ID,
            coachId: COACH.id,
            updatedById: COACH.id,
          }) as unknown,
          update: expect.objectContaining({ coachId: COACH.id, updatedById: COACH.id }) as unknown,
        }),
      );
      expect(audit.record).toHaveBeenCalledWith({
        action: 'WORKOUT_PLAN_SAVED',
        actorId: COACH.id,
        actorRole: 'COACH',
        subjectType: 'WorkoutPlan',
        subjectId: 'plan-1',
        subjectLabel: 'Maria Santos',
        details: { memberId: MEMBER_ID, created: true, days: 1, exercises: 1 },
      });
      expect(view).toEqual({
        plan: PLAN,
        coach: { firstName: 'Ana', lastName: 'Reyes' },
        updatedAt: NOW.toISOString(),
      });
    });
  });

  describe('readForMember', () => {
    it('is null when there is no plan', async () => {
      await expect(build().readForMember(MEMBER_ID)).resolves.toEqual({ plan: null });
    });

    it('hides the name of a coach whose account has gone, and never shows a corrupt body', async () => {
      prisma.workoutPlan.findUnique.mockResolvedValueOnce({
        id: 'plan-1',
        body: PLAN,
        updatedAt: NOW,
        coach: { firstName: 'Ana', lastName: 'Reyes', deletedAt: NOW },
      });
      await expect(build().readForMember(MEMBER_ID)).resolves.toEqual({
        plan: { plan: PLAN, coach: null, updatedAt: NOW.toISOString() },
      });

      prisma.workoutPlan.findUnique.mockResolvedValueOnce({
        id: 'plan-2',
        body: { days: 'nope' },
        updatedAt: NOW,
        coach: { firstName: 'Ana', lastName: 'Reyes', deletedAt: null },
      });
      await expect(build().readForMember(MEMBER_ID)).resolves.toEqual({ plan: null });
    });
  });

  /** The member's workout sessions need the row id too — it is the session's coachPlanId. */
  describe('planForMember', () => {
    it('returns the row id with the validated view, keyed on the member', async () => {
      prisma.workoutPlan.findUnique.mockResolvedValueOnce({
        id: 'plan-1',
        body: PLAN,
        updatedAt: NOW,
        coach: { firstName: 'Ana', lastName: 'Reyes', deletedAt: null },
      });
      await expect(build().planForMember(MEMBER_ID)).resolves.toEqual({
        id: 'plan-1',
        view: {
          plan: PLAN,
          coach: { firstName: 'Ana', lastName: 'Reyes' },
          updatedAt: NOW.toISOString(),
        },
      });
      expect((prisma.workoutPlan.findUnique.mock.calls[0] as [object])[0]).toMatchObject({
        where: { memberId: MEMBER_ID },
      });
    });

    it('is null with no plan, or a body that fails the schema', async () => {
      await expect(build().planForMember(MEMBER_ID)).resolves.toBeNull();
      prisma.workoutPlan.findUnique.mockResolvedValueOnce({
        id: 'plan-2',
        body: { days: 'nope' },
        updatedAt: NOW,
        coach: { firstName: 'Ana', lastName: 'Reyes', deletedAt: null },
      });
      await expect(build().planForMember(MEMBER_ID)).resolves.toBeNull();
    });
  });
});
