import {
  BadRequestException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  SESSION_LIMITS,
  WORKOUT_LIBRARY_LIMIT,
  parseMemberDay,
  parseMemberPlan,
  parseWorkoutIntake,
  type AdjustRequestBody,
  type AdjustResponse,
  type CoachPlanInWorkouts,
  type CreateWorkoutPlanBody,
  type MemberPlanBody,
  type MemberPlanDay,
  type MemberWorkoutPlanView,
  type PatchWorkoutPlanBody,
  type SwapRequestBody,
  type SwapResponse,
  type WorkoutAiQuotaView,
  type WorkoutIntakeSummary,
  type WorkoutsHome,
} from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { GeminiGateway, type AttemptContext } from '../assistant/gemini-gateway.service';
import { ASK_BUDGET_MS, remainingMs } from '../assistant/assistant-budget';
import { generationConfigFor } from '../assistant/gemini-models';
import { WorkoutQuotaService } from './workout-quota.service';
import { WorkoutDraftService, DRAFT_MISSING_MESSAGE } from './workout-draft.service';
import { UnusableReplyError, rotateForMember } from './member-workout-gemini';
import {
  ADJUST_RESPONSE_SCHEMA,
  ADJUST_SYSTEM_PROMPT,
  SWAP_RESPONSE_SCHEMA,
  SWAP_SYSTEM_PROMPT,
  adjustPrompt,
  parseSwapReply,
  readModelJson,
  sharedMedicalNotes,
  swapPrompt,
} from './member-plan-prompt';
import {
  PLAN_SELECT,
  intakeOf,
  intakeSummaryOf,
  toPlanView,
  type PlanRow,
} from './workouts.presenter';
import { WorkoutPlansService } from '../workout-plans/workout-plans.service';
import { WorkoutSessionsService, NO_COACH_PLAN_MESSAGE } from './workout-sessions.service';
import { toCoachPlanInWorkouts } from './workout-sessions.presenter';

export const PLAN_LIMIT_MESSAGE = `You already keep ${WORKOUT_LIBRARY_LIMIT} plans. Delete one to save this.`;
export const DRAFT_NOT_READY_MESSAGE = 'Your plan is not ready yet. Wait for it to finish.';
export const DRAFT_FAILED_MESSAGE = 'That generation did not finish. Start a new one.';
export const PLAN_INVALID_MESSAGE = 'This plan is not complete yet — check the highlighted fields.';

/** A Swap or Adjust answer is a few hundred tokens; this bounds a runaway. */
const TOOL_MAX_OUTPUT_TOKENS = 2048;

/**
 * The member's own plan library and the two paid tools (feat/member-workouts).
 *
 * KEYLESS AND HARD-CODED TO THE CALLER, like the rest of `/me`: every read
 * and write is `WHERE id AND memberId`, and an unscoped miss is the same
 * 404 as a plan that never existed. The identity is the token, never a
 * parameter, so there is no scope to resolve and no key to get wrong.
 *
 * Swap and Adjust are SYNCHRONOUS Gemini calls through the shared gateway:
 * one structured reply, validated by the shared schema. The AI action is
 * charged BEFORE the call (so a member cannot fire ten in flight against one
 * remaining action) and refunded on any failure after it.
 *
 * NEVER LOGS MEMBER DATA: counts, models and times only.
 */
@Injectable()
export class MemberWorkoutsService {
  private readonly logger = new Logger(MemberWorkoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: WorkoutQuotaService,
    private readonly drafts: WorkoutDraftService,
    private readonly gemini: GeminiGateway,
    // ── Workout sessions (feat/workout-sessions): the hub shows the coach's
    // plan, the open workout and the recent ones beside the AI plans.
    private readonly coachPlans: WorkoutPlansService,
    private readonly sessions: WorkoutSessionsService,
  ) {}

  /** `GET /me/workouts`. */
  async home(memberId: string, now: Date = new Date()): Promise<WorkoutsHome> {
    const [rows, draft, quota, coach, session, recent] = await Promise.all([
      this.prisma.memberWorkoutPlan.findMany({
        where: { memberId },
        orderBy: { createdAt: 'desc' },
        take: WORKOUT_LIBRARY_LIMIT,
        select: PLAN_SELECT,
      }),
      this.drafts.peek(memberId, now),
      this.quota.view(memberId, now),
      this.coachPlans.readForMember(memberId),
      this.sessions.current(memberId),
      this.sessions.list(memberId, SESSION_LIMITS.recentOnHub),
    ]);
    const plans = rows
      .map((row) => this.view(row))
      .filter((plan): plan is MemberWorkoutPlanView => plan !== null);
    return {
      plans,
      draft,
      quota,
      // The NEWEST plan's answers, even if its body no longer shows: the
      // wizard prefill is about what they asked for last time.
      lastIntake: rows.length === 0 ? null : intakeOf(rows[0]),
      // The coach's plan drives Today unless one of the member's AI plans is
      // active. Read from the rows, not `plans`: an active plan whose body no
      // longer shows is still the member's choice.
      coachPlan:
        coach.plan === null
          ? null
          : toCoachPlanInWorkouts(coach.plan, !rows.some((row) => row.isActive)),
      session,
      recent,
    };
  }

  /**
   * `POST /me/workouts/coach-plan/use` — the coach's plan drives Today again:
   * every AI plan of the member's stops being active. Idempotent.
   */
  async useCoachPlan(memberId: string): Promise<CoachPlanInWorkouts> {
    const { plan } = await this.coachPlans.readForMember(memberId);
    if (plan === null) {
      throw new DomainException('WORKOUT_DAY_UNKNOWN', NO_COACH_PLAN_MESSAGE, HttpStatus.NOT_FOUND);
    }
    const { count } = await this.prisma.memberWorkoutPlan.updateMany({
      where: { memberId, isActive: true },
      data: { isActive: false },
    });
    this.logger.log(`member-workout coach plan in use deactivated=${count}`);
    return toCoachPlanInWorkouts(plan, true);
  }

  /** `POST /me/workouts/plans` — the READY draft becomes a saved plan. */
  async save(
    memberId: string,
    body: CreateWorkoutPlanBody,
    now: Date = new Date(),
  ): Promise<MemberWorkoutPlanView> {
    const draft = await this.prisma.memberWorkoutDraft.findUnique({ where: { memberId } });
    if (draft === null) {
      throw new DomainException(
        'WORKOUT_DRAFT_MISSING',
        DRAFT_MISSING_MESSAGE,
        HttpStatus.NOT_FOUND,
      );
    }
    if (draft.status !== 'READY') {
      throw new DomainException(
        'WORKOUT_DRAFT_NOT_READY',
        draft.status === 'FAILED' ? DRAFT_FAILED_MESSAGE : DRAFT_NOT_READY_MESSAGE,
        HttpStatus.CONFLICT,
      );
    }
    // Both were validated on the way in; proving it again costs nothing and
    // means a row written around the API cannot become a plan.
    const plan = parseMemberPlan(draft.plan);
    const intake = parseWorkoutIntake({ ...(draft.intake as object), consent: true });
    if (!plan.ok || !intake.ok) {
      this.logger.error(`member-workout draft for job ${draft.jobId} fails the schema — not saved`);
      throw new DomainException(
        'WORKOUT_DRAFT_NOT_READY',
        DRAFT_FAILED_MESSAGE,
        HttpStatus.CONFLICT,
      );
    }
    const summary = intakeSummaryOf(intake.value);
    const name = body.name.trim();

    const row = await this.prisma.$transaction(async (tx) => {
      const count = await tx.memberWorkoutPlan.count({ where: { memberId } });
      if (count >= WORKOUT_LIBRARY_LIMIT) {
        throw new DomainException('WORKOUT_PLAN_LIMIT', PLAN_LIMIT_MESSAGE, HttpStatus.CONFLICT);
      }
      if (body.makeActive) {
        await tx.memberWorkoutPlan.updateMany({
          where: { memberId, isActive: true },
          data: { isActive: false },
        });
      }
      const created = await tx.memberWorkoutPlan.create({
        data: {
          memberId,
          name,
          goal: summary.goal,
          goalNotes: summary.goalNotes ?? null,
          experience: summary.experience,
          weekdays: summary.weekdays,
          sessionMinutes: summary.sessionMinutes,
          timeOfDay: summary.timeOfDay,
          healthFlag: summary.healthFlag,
          easyOn: summary.easyOn,
          useMeasurements: summary.use.measurements,
          useAttendance: summary.use.attendance,
          useBookings: summary.use.bookings,
          body: plan.value as unknown as Prisma.InputJsonValue,
          source: 'AI',
          model: draft.model,
          isActive: body.makeActive,
          consentAt: draft.consentAt,
        },
        select: PLAN_SELECT,
      });
      await tx.memberWorkoutDraft.deleteMany({ where: { memberId, jobId: draft.jobId } });
      return created;
    });

    this.logger.log(
      `member-workout plan saved days=${plan.value.days.length} active=${body.makeActive} at=${now.toISOString()}`,
    );
    return this.view(row) ?? this.fallbackView(row, plan.value, summary);
  }

  /** `GET /me/workouts/plans/:id`. */
  async get(memberId: string, id: string): Promise<MemberWorkoutPlanView> {
    const row = await this.prisma.memberWorkoutPlan.findFirst({
      where: { id, memberId },
      select: PLAN_SELECT,
    });
    const view = row === null ? null : this.view(row);
    if (view === null) throw new NotFoundException('Plan not found');
    return view;
  }

  /** `PATCH /me/workouts/plans/:id` — rename, activate (the others deactivate). */
  async patch(
    memberId: string,
    id: string,
    body: PatchWorkoutPlanBody,
  ): Promise<MemberWorkoutPlanView> {
    const data: Prisma.MemberWorkoutPlanUpdateManyMutationInput = {};
    if (body.name !== undefined) data.name = body.name.trim();
    if (body.isActive !== undefined) data.isActive = body.isActive;

    if (body.isActive === true) {
      await this.prisma.$transaction(async (tx) => {
        await tx.memberWorkoutPlan.updateMany({
          where: { memberId, isActive: true, id: { not: id } },
          data: { isActive: false },
        });
        await this.applyPatch(tx, memberId, id, data);
      });
    } else if (Object.keys(data).length > 0) {
      await this.applyPatch(this.prisma, memberId, id, data);
    }
    return this.get(memberId, id);
  }

  /** `PUT /me/workouts/plans/:id/body` — hand edits and kept Swap/Adjust results. */
  async putBody(memberId: string, id: string, plan: unknown): Promise<MemberWorkoutPlanView> {
    const parsed = parseMemberPlan(plan);
    if (!parsed.ok) {
      throw new DomainException(
        'WORKOUT_PLAN_INVALID',
        PLAN_INVALID_MESSAGE,
        HttpStatus.BAD_REQUEST,
        {
          errors: parsed.errors,
        },
      );
    }
    const { count } = await this.prisma.memberWorkoutPlan.updateMany({
      where: { id, memberId },
      data: {
        body: parsed.value as unknown as Prisma.InputJsonValue,
        source: 'EDITED',
        model: null,
      },
    });
    if (count === 0) throw new NotFoundException('Plan not found');
    return this.get(memberId, id);
  }

  /** `DELETE /me/workouts/plans/:id`. */
  async remove(memberId: string, id: string): Promise<{ id: string }> {
    const { count } = await this.prisma.memberWorkoutPlan.deleteMany({ where: { id, memberId } });
    if (count === 0) throw new NotFoundException('Plan not found');
    return { id };
  }

  /**
   * The member's medical notes for a swap or adjust prompt — `null` unless
   * they ticked "Let the workout planner use my medical notes" on My account.
   */
  private async sharedMedicalNotes(memberId: string): Promise<string | null> {
    const row = await this.prisma.user.findUnique({
      where: { id: memberId },
      select: { medicalNotes: true, shareMedicalWithPlanner: true },
    });
    return sharedMedicalNotes(row);
  }

  /** `POST /me/workouts/plans/:id/swap` — three alternatives for one exercise. */
  async swap(
    memberId: string,
    id: string,
    body: SwapRequestBody,
    now: Date = new Date(),
  ): Promise<SwapResponse> {
    const view = await this.get(memberId, id);
    const day = view.plan.days.find((d) => d.weekday === body.weekday);
    const exercise = day?.exercises[body.index];
    if (day === undefined || exercise === undefined) {
      throw new NotFoundException('Exercise not found');
    }
    const prompt = swapPrompt({
      exercise,
      focus: day.focus,
      experience: view.intake.experience,
      healthFlag: view.intake.healthFlag,
      easyOn: view.intake.easyOn,
      medicalNotes: await this.sharedMedicalNotes(memberId),
    });

    const quota = await this.charge(memberId, now);
    const { model, value, startedAt } = await this.paidAsk(
      memberId,
      now,
      'member-swap',
      (modelName, context) =>
        this.askJson(
          modelName,
          context,
          SWAP_SYSTEM_PROMPT,
          SWAP_RESPONSE_SCHEMA,
          prompt,
          (json) => {
            const parsed = parseSwapReply(json);
            if (!parsed.ok) throw new UnusableReplyError(`swap: ${parsed.errors.length} error(s)`);
            return parsed.value;
          },
        ),
    );
    this.logger.log(`member-swap answered model=${model} ms=${Date.now() - startedAt}`);
    return { alternatives: value, quota };
  }

  /** `POST /me/workouts/plans/:id/adjust` — a rewritten day, same weekday. */
  async adjust(
    memberId: string,
    id: string,
    body: AdjustRequestBody,
    now: Date = new Date(),
  ): Promise<AdjustResponse> {
    const hasPreset = body.preset !== undefined;
    const hasRequest = body.request !== undefined && body.request.trim() !== '';
    if (hasPreset === hasRequest) {
      throw new BadRequestException('Send exactly one of preset and request.');
    }
    const view = await this.get(memberId, id);
    const day = view.plan.days.find((d) => d.weekday === body.weekday);
    if (day === undefined) throw new NotFoundException('Day not found');

    const summary = {
      goal: view.intake.goal,
      experience: view.intake.experience,
      sessionMinutes: view.intake.sessionMinutes,
      healthFlag: view.intake.healthFlag,
      easyOn: view.intake.easyOn,
    };
    const medicalNotes = await this.sharedMedicalNotes(memberId);
    const prompt = hasPreset
      ? adjustPrompt({ day, summary, medicalNotes, preset: body.preset! })
      : adjustPrompt({ day, summary, medicalNotes, request: body.request!.trim() });

    const quota = await this.charge(memberId, now);
    const { model, value, startedAt } = await this.paidAsk(
      memberId,
      now,
      'member-adjust',
      (modelName, context) =>
        this.askJson(
          modelName,
          context,
          ADJUST_SYSTEM_PROMPT,
          ADJUST_RESPONSE_SCHEMA,
          prompt,
          (json) => {
            const errors: string[] = [];
            const rewritten = parseMemberDay(json, 'day', errors);
            if (rewritten === null)
              throw new UnusableReplyError(`adjust: ${errors.length} error(s)`);
            if (rewritten.weekday !== body.weekday)
              throw new UnusableReplyError('adjust: weekday changed');
            return rewritten;
          },
        ),
    );
    this.logger.log(`member-adjust answered model=${model} ms=${Date.now() - startedAt}`);
    return { day: value satisfies MemberPlanDay, quota };
  }

  // ── Pieces ─────────────────────────────────────────────────────────────

  private async applyPatch(
    tx: Pick<PrismaService, 'memberWorkoutPlan'>,
    memberId: string,
    id: string,
    data: Prisma.MemberWorkoutPlanUpdateManyMutationInput,
  ): Promise<void> {
    const { count } = await tx.memberWorkoutPlan.updateMany({ where: { id, memberId }, data });
    if (count === 0) throw new NotFoundException('Plan not found');
  }

  private charge(memberId: string, now: Date): Promise<WorkoutAiQuotaView> {
    return this.prisma.$transaction((tx) => this.quota.charge(tx, memberId, now));
  }

  /** A charged call: any failure after the charge gives the action back. */
  private async paidAsk<T>(
    memberId: string,
    chargedAt: Date,
    label: string,
    attempt: (model: string, context: AttemptContext) => Promise<T>,
  ): Promise<{ model: string; value: T; startedAt: number }> {
    try {
      return await rotateForMember(this.gemini, label, ASK_BUDGET_MS, attempt);
    } catch (caught) {
      await this.quota.refund(memberId, chargedAt);
      throw caught;
    }
  }

  /** One structured call, no tools; the reply goes through `read` or is unusable. */
  private async askJson<T>(
    model: string,
    context: AttemptContext,
    systemInstruction: string,
    responseSchema: typeof SWAP_RESPONSE_SCHEMA,
    prompt: string,
    read: (json: unknown) => T,
  ): Promise<T> {
    const generative = context.client.getGenerativeModel({
      model,
      systemInstruction,
      generationConfig: {
        ...generationConfigFor(model),
        maxOutputTokens: TOOL_MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
        responseSchema,
      },
    });
    context.countRequest();
    const reply = await generative.generateContent(prompt, {
      timeout: remainingMs(context.deadline),
    });
    const json = readModelJson(safeText(() => reply.response.text()));
    if (json === null) throw new UnusableReplyError('not JSON');
    return read(json);
  }

  /** Null when the stored body no longer passes the schema — logged by id. */
  private view(row: PlanRow): MemberWorkoutPlanView | null {
    const view = toPlanView(row);
    if (view === null) {
      this.logger.error(`member workout plan ${row.id} fails the plan schema — not shown`);
    }
    return view;
  }

  /** The row we just wrote from a validated plan cannot fail the schema; this keeps the type honest. */
  private fallbackView(
    row: PlanRow,
    plan: MemberPlanBody,
    intake: WorkoutIntakeSummary,
  ): MemberWorkoutPlanView {
    return {
      id: row.id,
      name: row.name,
      isActive: row.isActive,
      intake,
      plan,
      source: row.source,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function safeText(read: () => string): string {
  try {
    return read();
  } catch {
    return '';
  }
}
