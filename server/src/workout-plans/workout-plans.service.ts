import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  parseWorkoutPlan,
  type WorkoutPlanBody,
  type WorkoutPlanSuggestion,
  type WorkoutPlanView,
} from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { gymToday } from '../common/time/gym-time';
import type { AuthUser } from '../auth/auth.types';
import type { ScopedWhere } from '../rbac/scope.util';
import { ProgressService } from '../me/progress.service';
import { MeCheckInsService } from '../me/me-check-ins.service';
import { GeminiGateway, type GeminiCopy } from '../assistant/gemini-gateway.service';
import { ASK_BUDGET_MS, remainingMs } from '../assistant/assistant-budget';
import { GymEquipmentService } from '../gym-equipment/gym-equipment.service';
import { generationConfigFor } from '../assistant/gemini-models';
import {
  WORKOUT_PLAN_RESPONSE_SCHEMA,
  WORKOUT_PLAN_SYSTEM_PROMPT,
  buildPlanContext,
  planPrompt,
  readModelJson,
} from './workout-plan-prompt';

export type PlanActor = Pick<AuthUser, 'id' | 'role'>;

type MemberScope = ScopedWhere<Prisma.UserWhereInput>;

/** A week of JSON is a few hundred tokens; this bounds a runaway, not a plan. */
const PLAN_MAX_OUTPUT_TOKENS = 4096;

/**
 * The coach's words when the shared Gemini gateway cannot answer. The quota is
 * SHARED with members' questions to the assistant (one free-tier allowance per
 * project), so "busy" here can mean members used it up — the copy says so.
 */
const PLAN_COPY: GeminiCopy = {
  notConfigured:
    'Plan suggestions are switched off right now. You can still write the plan yourself.',
  busy: 'The plan assistant is busy right now — it shares its daily allowance with the member assistant. Try again in a minute, or write the plan yourself.',
  busyUntil: (at) =>
    `The plan assistant has used today's allowance (shared with the member assistant). It will be back at ${at}; you can still write the plan yourself.`,
  timeout: 'That plan took too long to draft. Try again, or write the plan yourself.',
};

const PLAN_SELECT = {
  id: true,
  body: true,
  updatedAt: true,
  coach: { select: { firstName: true, lastName: true, deletedAt: true } },
} as const;

interface PlanRow {
  id: string;
  body: Prisma.JsonValue;
  updatedAt: Date;
  coach: { firstName: string; lastName: string; deletedAt: Date | null };
}

/**
 * A member's workout plan: the AI draft, the coach's save, and the member's
 * read.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * - SUGGEST (`workout.suggest`, COACH at OWN) — ONE Gemini call through the
 *   shared `GeminiGateway` (rotation, quota ledger, budget), with NO tools and
 *   a JSON response schema. The server builds the context itself from the
 *   member's progress and attendance, through the same `coachedMember`-scoped
 *   read the progress screen uses. The reply is validated by
 *   `parseWorkoutPlan` and returned as a DRAFT; nothing is saved.
 * - SAVE (`workout.manage`, COACH at OWN) — the coach's edited plan,
 *   validated against the same schema, one row per member, audited.
 * - READ — the coach (`workout.manage`) and the member (`workout.self`).
 *
 * NEVER LOGS MEMBER DATA: counts, models and times only.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class WorkoutPlansService {
  private readonly logger = new Logger(WorkoutPlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly audit: AuditService,
    private readonly progress: ProgressService,
    private readonly checkIns: MeCheckInsService,
    private readonly gemini: GeminiGateway,
    private readonly equipment: GymEquipmentService,
  ) {}

  async suggest(
    actor: PlanActor,
    memberId: string,
    scope: MemberScope,
    now: Date = new Date(),
  ): Promise<WorkoutPlanSuggestion> {
    // Scope first: an unassigned member is the same 404 whether or not the
    // AI is configured.
    const progress = await this.progress.memberProgress(actor, memberId, scope, now);
    this.gemini.assertEnabled(PLAN_COPY);

    const [checkIns, account, equipment] = await Promise.all([
      this.checkIns.summary(progress.member.id, now),
      // The member's own height (My account) — ahead of a measured one.
      this.prisma.user.findUnique({
        where: { id: progress.member.id },
        select: { heightCm: true },
      }),
      // The gym's equipment list (Admin → Settings); [] on any failure.
      this.equipment.forPrompt(),
    ]);
    const context = buildPlanContext(
      progress,
      checkIns,
      gymToday(now, this.gym.timeZone),
      account,
      equipment,
    );
    const prompt = planPrompt(context);

    const { model, value, attempts, startedAt } = await this.gemini.rotate(
      'workout-plan',
      PLAN_COPY,
      ASK_BUDGET_MS,
      async (modelName, attempt) => {
        const generative = attempt.client.getGenerativeModel({
          model: modelName,
          systemInstruction: WORKOUT_PLAN_SYSTEM_PROMPT,
          generationConfig: {
            ...generationConfigFor(modelName),
            maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS,
            responseMimeType: 'application/json',
            responseSchema: WORKOUT_PLAN_RESPONSE_SCHEMA,
          },
        });
        attempt.countRequest();
        const reply = await generative.generateContent(prompt, {
          timeout: remainingMs(attempt.deadline),
        });
        return {
          // `.text()` throws on a blocked or empty candidate: that is an
          // unusable reply, not a model failure worth rotating for.
          text: safeText(() => reply.response.text()),
          finish: reply.response.candidates?.[0]?.finishReason ?? 'UNKNOWN',
        };
      },
    );

    const parsed = parseWorkoutPlan(readModelJson(value.text));
    if (!parsed.ok) {
      this.logger.warn(
        `workout-plan reply rejected model=${model} finish=${value.finish} errors=${parsed.errors.length}`,
      );
      throw new DomainException(
        'WORKOUT_PLAN_SUGGESTION_INVALID',
        'The suggestion came back in a shape we could not use. Try again, or write the plan yourself.',
        HttpStatus.BAD_GATEWAY,
      );
    }

    this.logger.log(
      `workout-plan suggested model=${model} ms=${Date.now() - startedAt} attempts=${attempts} ` +
        `days=${parsed.plan.days.length} exercises=${countExercises(parsed.plan)} ` +
        `quota=${this.gemini.describeQuota(model)}`,
    );
    return { draft: parsed.plan };
  }

  async save(
    actor: PlanActor,
    memberId: string,
    scope: MemberScope,
    body: unknown,
  ): Promise<WorkoutPlanView> {
    const member = await this.memberInScope(actor, memberId, scope);

    const parsed = parseWorkoutPlan(body);
    if (!parsed.ok) {
      throw new DomainException(
        'WORKOUT_PLAN_INVALID',
        'This plan is not complete yet — check the highlighted fields.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { errors: parsed.errors },
      );
    }

    const existing = await this.prisma.workoutPlan.findUnique({
      where: { memberId: member.id },
      select: { id: true },
    });
    const row = await this.prisma.workoutPlan.upsert({
      where: { memberId: member.id },
      create: {
        memberId: member.id,
        coachId: actor.id,
        body: parsed.plan as unknown as Prisma.InputJsonValue,
        updatedById: actor.id,
      },
      update: {
        coachId: actor.id,
        body: parsed.plan as unknown as Prisma.InputJsonValue,
        updatedById: actor.id,
      },
      select: PLAN_SELECT,
    });

    await this.audit.record({
      action: 'WORKOUT_PLAN_SAVED',
      actorId: actor.id,
      actorRole: actor.role,
      subjectType: 'WorkoutPlan',
      subjectId: row.id,
      subjectLabel: `${member.firstName} ${member.lastName}`.trim(),
      // Counts only: the plan is the member's, not the audit screen's.
      details: {
        memberId: member.id,
        created: existing === null,
        days: parsed.plan.days.length,
        exercises: countExercises(parsed.plan),
      },
    });

    return (
      this.toView(row) ?? { plan: parsed.plan, coach: null, updatedAt: row.updatedAt.toISOString() }
    );
  }

  /** The coach's read of an assigned member's current plan. */
  async readForCoach(
    actor: PlanActor,
    memberId: string,
    scope: MemberScope,
  ): Promise<{ plan: WorkoutPlanView | null }> {
    const member = await this.memberInScope(actor, memberId, scope);
    return { plan: await this.planOf(member.id) };
  }

  /** The member's own plan. The subject is the token, never a parameter. */
  async readForMember(userId: string): Promise<{ plan: WorkoutPlanView | null }> {
    return { plan: await this.planOf(userId) };
  }

  /**
   * The member's own plan WITH its row id — what a workout session started
   * from the coach's plan links to (feat/workout-sessions). Same read, same
   * schema check, same "a gone coach has no name" rule as `readForMember`.
   */
  async planForMember(userId: string): Promise<{ id: string; view: WorkoutPlanView } | null> {
    const row = await this.prisma.workoutPlan.findUnique({
      where: { memberId: userId },
      select: PLAN_SELECT,
    });
    const view = row === null ? null : this.toView(row);
    return row === null || view === null ? null : { id: row.id, view };
  }

  private async planOf(memberId: string): Promise<WorkoutPlanView | null> {
    return (await this.planForMember(memberId))?.view ?? null;
  }

  /**
   * Every read goes back through the schema, so the wire type is PROVEN rather
   * than cast. A stored body that fails it (only possible by writing around
   * the API) is shown as no plan, and logged by id.
   */
  private toView(row: PlanRow): WorkoutPlanView | null {
    const parsed = parseWorkoutPlan(row.body);
    if (!parsed.ok) {
      this.logger.error(`workout plan ${row.id} fails the plan schema — not shown`);
      return null;
    }
    return {
      plan: parsed.plan,
      coach:
        row.coach.deletedAt === null
          ? { firstName: row.coach.firstName, lastName: row.coach.lastName }
          : null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** `coachedMember` at OWN: ACTIVE assignment to the caller, no self branch. */
  private async memberInScope(
    actor: PlanActor,
    memberId: string,
    scope: MemberScope,
  ): Promise<{ id: string; firstName: string; lastName: string }> {
    if (memberId === actor.id) throw new NotFoundException('Member not found');
    const member = await this.prisma.user.findFirst({
      // ANDed, never spread: a spread would clobber the scope's own keys.
      where: { AND: [{ id: memberId }, scope] },
      select: { id: true, firstName: true, lastName: true },
    });
    if (member === null) throw new NotFoundException('Member not found');
    return member;
  }
}

function countExercises(plan: WorkoutPlanBody): number {
  return plan.days.reduce((sum, day) => sum + day.exercises.length, 0);
}

function safeText(read: () => string): string {
  try {
    return read();
  } catch {
    return '';
  }
}
