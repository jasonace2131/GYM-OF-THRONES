import { randomUUID } from 'node:crypto';
import { BadRequestException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  GOAL_NOT_SUITABLE_MESSAGE,
  WORKOUT_DRAFT_STALE_MS,
  WORKOUT_LIMITS,
  bmiOf,
  isGoalSuitable,
  parseGuidance,
  parseMemberDay,
  parseMemberPlan,
  parseWorkoutIntake,
  type MemberPlanBody,
  type WorkoutAiQuotaView,
  type WorkoutDraftView,
  type WorkoutGoal,
  type WorkoutIntake,
} from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { OpeningHoursService } from '../config/opening-hours.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { addDays, gymToday } from '../common/time/gym-time';
import { ProgressService } from '../me/progress.service';
import { MeCheckInsService } from '../me/me-check-ins.service';
import { BookingsService } from '../classes/bookings.service';
import { GeminiGateway, type AttemptContext } from '../assistant/gemini-gateway.service';
import { remainingMs } from '../assistant/assistant-budget';
import { classifyError, generationConfigFor } from '../assistant/gemini-models';
import { GymEquipmentService } from '../gym-equipment/gym-equipment.service';
import { WorkoutQuotaService } from './workout-quota.service';
import {
  DraftGoneError,
  MEMBER_COPY,
  UnusableReplyError,
  rotateForMember,
} from './member-workout-gemini';
import { SYSTEM_PROMPT, buildContext, parseLine, userPrompt } from './member-plan-prompt';
import { EMPTY_PLAN, intakeSummaryOf, toDraftView, type PartialPlan } from './workouts.presenter';

/**
 * The whole generation may take this long across every model it tries. A
 * full week of NDJSON on a free-tier model is 15-30 s; the member sees Day 1
 * long before that, and the portal polls rather than waits.
 */
export const DRAFT_BUDGET_MS = 40_000;

/** A week of JSON is a couple of thousand tokens; this bounds a runaway. */
const PLAN_MAX_OUTPUT_TOKENS = 8192;

/** How far ahead booked classes are read for the prompt. */
const BOOKINGS_AHEAD_DAYS = 13;

export const DRAFT_RUNNING_MESSAGE =
  'A plan is already being written. Wait for it to finish, or cancel it first.';
export const DRAFT_MISSING_MESSAGE = 'No plan is being written. Start one from the wizard.';
export const CONSENT_REQUIRED_MESSAGE =
  'Please agree to send your answers to the AI before generating a plan.';
const FACTS_FAILED_MESSAGE = 'Something went wrong on our side. Try again.';

type DraftDelegate = Prisma.TransactionClient['memberWorkoutDraft'];

/**
 * The member's draft — which IS the generation job (feat/member-workouts).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE ROW, ONE JOB, ONE KEY.
 *
 * `start` charges the quota, writes a RUNNING row with a fresh `jobId` and
 * returns at once; `run` proceeds without being awaited. Every write the job
 * makes is `updateMany WHERE memberId AND jobId`: a member who cancels (the
 * row is deleted) or starts again (a new jobId) makes the old job's writes
 * match nothing, and the job notices and stops. Nothing else — no process
 * memory, no timer — knows the job exists, so a restart cannot orphan it:
 * a RUNNING row past WORKOUT_DRAFT_STALE_MS is failed by the next read.
 *
 * The model's reply is NDJSON and is written into the row line by line, so
 * Day 1 is on the member's screen while the rest is still being written
 * (REQ034). A bad line throws `UnusableReplyError`; the gateway rotates to
 * the next model, and the attempt starts by resetting the partial plan, so
 * no model ever inherits another's half.
 *
 * NEVER LOGS MEMBER DATA: counts, models, classes and times only.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class WorkoutDraftService {
  private readonly logger = new Logger(WorkoutDraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly quota: WorkoutQuotaService,
    private readonly progress: ProgressService,
    private readonly checkIns: MeCheckInsService,
    private readonly bookings: BookingsService,
    private readonly hours: OpeningHoursService,
    private readonly gemini: GeminiGateway,
    private readonly equipment: GymEquipmentService,
  ) {}

  /** `POST /me/workouts/drafts` — 202 with the RUNNING draft and the quota. */
  async start(
    memberId: string,
    body: unknown,
    now: Date = new Date(),
  ): Promise<{ draft: WorkoutDraftView; quota: WorkoutAiQuotaView }> {
    // Consent first, so the member reads the right sentence when they simply
    // did not tick the box — not "consent must be true" among nine others.
    if (
      body === null ||
      typeof body !== 'object' ||
      (body as { consent?: unknown }).consent !== true
    ) {
      throw new DomainException(
        'WORKOUT_CONSENT_REQUIRED',
        CONSENT_REQUIRED_MESSAGE,
        HttpStatus.BAD_REQUEST,
      );
    }
    const parsed = parseWorkoutIntake(body);
    if (!parsed.ok) throw new BadRequestException(parsed.errors);
    const intake = parsed.value;
    await this.assertGoalSuits(memberId, intake.goal);

    // A stuck job must not block the member for ever: time it out here as
    // the poll would, then apply the running rule to what is left.
    const existing = await this.expireIfStale(memberId, now);
    if (existing?.status === 'RUNNING') {
      throw new DomainException(
        'WORKOUT_DRAFT_RUNNING',
        DRAFT_RUNNING_MESSAGE,
        HttpStatus.CONFLICT,
      );
    }

    const summary = intakeSummaryOf(intake);
    const jobId = randomUUID();
    const quota = await this.prisma.$transaction(async (tx) => {
      const charged = await this.quota.charge(tx, memberId, now);
      await tx.memberWorkoutDraft.deleteMany({ where: { memberId, status: { not: 'RUNNING' } } });
      // Never a caught unique violation inside the transaction (25P02): the
      // claim is the non-throwing form, and a lost claim rolls back the charge.
      const { count } = await tx.memberWorkoutDraft.createMany({
        data: [
          {
            memberId,
            jobId,
            status: 'RUNNING',
            intake: summary,
            plan: EMPTY_PLAN as unknown as Prisma.InputJsonValue,
            consentAt: now,
            startedAt: now,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) {
        throw new DomainException(
          'WORKOUT_DRAFT_RUNNING',
          DRAFT_RUNNING_MESSAGE,
          HttpStatus.CONFLICT,
        );
      }
      return charged;
    });

    this.launch(memberId, jobId, intake, now);

    return {
      draft: toDraftView({
        status: 'RUNNING',
        intake: summary,
        plan: EMPTY_PLAN as unknown as Prisma.JsonValue,
        error: null,
        startedAt: now,
        firstDayAt: null,
      }),
      quota,
    };
  }

  /** Fire and forget. `run` catches everything; this catches what it cannot. */
  launch(memberId: string, jobId: string, intake: WorkoutIntake, startedAt: Date): void {
    void this.run(memberId, jobId, intake, startedAt).catch((caught: unknown) => {
      this.logger.error(
        `member-workout job crashed job=${jobId}`,
        caught instanceof Error ? caught.stack : String(caught),
      );
    });
  }

  /** The job. Public so a test can await it; never awaited by `start`. */
  async run(
    memberId: string,
    jobId: string,
    intake: WorkoutIntake,
    startedAt: Date,
  ): Promise<void> {
    const t0 = Date.now();
    let facts: ReturnType<typeof buildContext> | null = null;
    try {
      facts = buildContext(intake, await this.facts(memberId, intake, startedAt));
    } catch (caught) {
      // The gym's own reads failed — a database problem, not the model's.
      this.logger.error(
        `member-workout facts failed job=${jobId} ms=${Date.now() - t0}`,
        caught instanceof Error ? caught.stack : String(caught),
      );
      await this.fail(memberId, jobId, startedAt, FACTS_FAILED_MESSAGE);
      return;
    }
    const prompt = userPrompt(facts);

    try {
      const { model, value, attempts } = await rotateForMember(
        this.gemini,
        'member-workout',
        DRAFT_BUDGET_MS,
        (modelName, context) =>
          this.attempt(memberId, jobId, intake, modelName, context, prompt, startedAt),
      );
      const { count } = await this.prisma.memberWorkoutDraft.updateMany({
        where: { memberId, jobId },
        data: {
          status: 'READY',
          plan: value as unknown as Prisma.InputJsonValue,
          model,
          error: null,
          finishedAt: new Date(),
        },
      });
      if (count === 0) {
        this.logger.log(`member-workout cancelled before finishing job=${jobId}`);
        return;
      }
      this.logger.log(
        `member-workout ready model=${model} ms=${Date.now() - t0} attempts=${attempts} ` +
          `days=${value.days.length} exercises=${countExercises(value)} ` +
          `quota=${this.gemini.describeQuota(model)}`,
      );
    } catch (caught) {
      if (caught instanceof DraftGoneError) {
        this.logger.log(`member-workout cancelled mid-stream job=${jobId} ms=${Date.now() - t0}`);
        return;
      }
      const message = caught instanceof DomainException ? caught.message : MEMBER_COPY.unusable;
      const kind = caught instanceof DomainException ? caught.code : classifyError(caught);
      this.logger.warn(`member-workout failed class=${kind} ms=${Date.now() - t0} job=${jobId}`);
      await this.fail(memberId, jobId, startedAt, message);
    }
  }

  /** `GET /me/workouts/draft` — the poll target. Times out a stale job. */
  async read(memberId: string, now: Date = new Date()): Promise<WorkoutDraftView> {
    const row = await this.expireIfStale(memberId, now);
    if (row === null) {
      throw new DomainException(
        'WORKOUT_DRAFT_MISSING',
        DRAFT_MISSING_MESSAGE,
        HttpStatus.NOT_FOUND,
      );
    }
    return toDraftView(row);
  }

  /** The home screen's read: null rather than 404. */
  async peek(memberId: string, now: Date = new Date()): Promise<WorkoutDraftView | null> {
    const row = await this.expireIfStale(memberId, now);
    return row === null ? null : toDraftView(row);
  }

  /** `DELETE /me/workouts/draft`. No refund: the action was spent. */
  async cancel(memberId: string): Promise<{ cancelled: boolean }> {
    const { count } = await this.prisma.memberWorkoutDraft.deleteMany({ where: { memberId } });
    return { cancelled: count > 0 };
  }

  /**
   * The backstop for the wizard's BMI rule (owner, 2026-10-23): the account's
   * height and weight decide, and "Lose fat" under BMI 18.5 is refused before
   * anything is charged. Missing numbers allow every goal.
   */
  private async assertGoalSuits(memberId: string, goal: WorkoutGoal): Promise<void> {
    const body = await this.prisma.user.findUnique({
      where: { id: memberId },
      select: { heightCm: true, weightKg: true },
    });
    const bmi = bmiOf(body?.heightCm ?? null, body?.weightKg ?? null);
    if (!isGoalSuitable(goal, bmi)) {
      throw new DomainException(
        'GOAL_NOT_SUITABLE',
        GOAL_NOT_SUITABLE_MESSAGE,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  // ── The job's pieces ──────────────────────────────────────────────────────

  private async facts(memberId: string, intake: WorkoutIntake, now: Date) {
    const today = gymToday(now, this.gym.timeZone);
    const [progress, checkIns, bookings, hours, account, equipment] = await Promise.all([
      intake.use.measurements ? this.progress.summary(memberId, now) : null,
      intake.use.attendance ? this.checkIns.summary(memberId, now) : null,
      intake.use.bookings
        ? this.bookings.mine(
            memberId,
            { from: today, to: addDays(today, BOOKINGS_AHEAD_DAYS) },
            now,
          )
        : null,
      this.hours.week(),
      // The member's account page: height and weight (ahead of a recorded
      // measurement), and their medical notes if they opted in
      // (member-plan-prompt).
      this.prisma.user.findUnique({
        where: { id: memberId },
        select: {
          heightCm: true,
          weightKg: true,
          medicalNotes: true,
          shareMedicalWithPlanner: true,
        },
      }),
      // The gym's equipment list (Admin → Settings); [] on any failure.
      this.equipment.forPrompt(),
    ]);
    return {
      progress,
      checkIns,
      bookings,
      hours,
      today,
      now,
      timeZone: this.gym.timeZone,
      account,
      equipment,
    };
  }

  /** One model's try. Throws UnusableReplyError (rotate) or DraftGoneError (stop). */
  private async attempt(
    memberId: string,
    jobId: string,
    intake: WorkoutIntake,
    model: string,
    context: AttemptContext,
    prompt: string,
    startedAt: Date,
  ): Promise<MemberPlanBody> {
    // A retry never keeps a previous model's half.
    await this.write(memberId, jobId, {
      plan: EMPTY_PLAN as unknown as Prisma.InputJsonValue,
      firstDayAt: null,
    });

    const generative = context.client.getGenerativeModel({
      model,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: { ...generationConfigFor(model), maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS },
    });
    context.countRequest();
    const result = await generative.generateContentStream(prompt, {
      timeout: remainingMs(context.deadline),
    });

    const partial: PartialPlan = { summary: null, days: [], guidance: null };
    let buffer = '';
    for await (const chunk of result.stream) {
      buffer += safeText(() => chunk.text());
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        await this.handleLine(memberId, jobId, intake, model, partial, line, startedAt);
        newline = buffer.indexOf('\n');
      }
    }
    if (buffer.trim() !== '') {
      await this.handleLine(memberId, jobId, intake, model, partial, buffer, startedAt);
    }

    const parsed = parseMemberPlan({
      summary: partial.summary,
      days: partial.days,
      guidance: partial.guidance,
    });
    if (!parsed.ok) throw new UnusableReplyError(`plan: ${parsed.errors.length} error(s)`);
    return parsed.value;
  }

  private async handleLine(
    memberId: string,
    jobId: string,
    intake: WorkoutIntake,
    model: string,
    partial: PartialPlan,
    text: string,
    startedAt: Date,
  ): Promise<void> {
    const event = parseLine(text);
    if (event.kind === 'blank') return;
    if (event.kind === 'invalid') throw new UnusableReplyError(event.reason);

    const errors: string[] = [];
    let firstDay = false;
    if (event.kind === 'summary') {
      if (partial.summary !== null) throw new UnusableReplyError('second summary');
      const summary = typeof event.summary === 'string' ? event.summary.trim() : '';
      if (summary.length < 1 || summary.length > WORKOUT_LIMITS.summaryMax) {
        throw new UnusableReplyError('summary length');
      }
      partial.summary = summary;
    } else if (event.kind === 'day') {
      if (partial.summary === null) throw new UnusableReplyError('day before summary');
      if (partial.guidance !== null) throw new UnusableReplyError('day after guidance');
      const day = parseMemberDay(event.day, 'day', errors);
      if (day === null) throw new UnusableReplyError(`day: ${errors.length} error(s)`);
      if (!intake.weekdays.includes(day.weekday))
        throw new UnusableReplyError('weekday not chosen');
      if (partial.days.some((d) => d.weekday === day.weekday)) {
        throw new UnusableReplyError('weekday repeated');
      }
      firstDay = partial.days.length === 0;
      partial.days.push(day);
    } else {
      if (partial.days.length === 0) throw new UnusableReplyError('guidance before any day');
      if (partial.guidance !== null) throw new UnusableReplyError('second guidance');
      const guidance = parseGuidance(event.guidance, 'guidance', errors);
      if (guidance === null) throw new UnusableReplyError(`guidance: ${errors.length} error(s)`);
      partial.guidance = guidance;
    }

    // A snapshot, not the live object: the row holds what had landed by then.
    const data: Prisma.MemberWorkoutDraftUpdateManyMutationInput = {
      plan: {
        summary: partial.summary,
        days: [...partial.days],
        guidance: partial.guidance,
      } as unknown as Prisma.InputJsonValue,
    };
    if (firstDay) {
      const at = new Date();
      data.firstDayAt = at;
      // REQ034's evidence, per generation: "Day 1 on screen in under five seconds".
      this.logger.log(
        `member-workout first day ms=${at.getTime() - startedAt.getTime()} model=${model}`,
      );
    }
    await this.write(memberId, jobId, data);
  }

  /** Every job write. Zero rows means the draft is gone: stop. */
  private async write(
    memberId: string,
    jobId: string,
    data: Prisma.MemberWorkoutDraftUpdateManyMutationInput,
  ): Promise<void> {
    const { count } = await this.prisma.memberWorkoutDraft.updateMany({
      where: { memberId, jobId },
      data,
    });
    if (count === 0) throw new DraftGoneError();
  }

  /** FAILED with member copy, and the action back — unless the draft is already gone. */
  private async fail(
    memberId: string,
    jobId: string,
    startedAt: Date,
    message: string,
  ): Promise<void> {
    const { count } = await this.prisma.memberWorkoutDraft.updateMany({
      where: { memberId, jobId },
      data: { status: 'FAILED', error: message, finishedAt: new Date() },
    });
    if (count > 0) await this.quota.refund(memberId, startedAt);
  }

  /**
   * The member's draft row, after failing it if it is RUNNING past the stale
   * window. Returned as it now stands, or null when there is none.
   */
  private async expireIfStale(
    memberId: string,
    now: Date,
  ): Promise<Awaited<ReturnType<DraftDelegate['findUnique']>>> {
    const row = await this.prisma.memberWorkoutDraft.findUnique({ where: { memberId } });
    if (row === null || row.status !== 'RUNNING') return row;
    if (now.getTime() - row.startedAt.getTime() <= WORKOUT_DRAFT_STALE_MS) return row;

    const { count } = await this.prisma.memberWorkoutDraft.updateMany({
      where: { memberId, jobId: row.jobId, status: 'RUNNING' },
      data: { status: 'FAILED', error: MEMBER_COPY.timeout, finishedAt: now },
    });
    if (count > 0) {
      await this.quota.refund(memberId, row.startedAt);
      this.logger.warn(
        `member-workout stale job failed job=${row.jobId} age=${now.getTime() - row.startedAt.getTime()}ms`,
      );
    }
    return { ...row, status: 'FAILED', error: MEMBER_COPY.timeout, finishedAt: now };
  }
}

function countExercises(plan: MemberPlanBody): number {
  return plan.days.reduce((sum, day) => sum + day.exercises.length, 0);
}

function safeText(read: () => string): string {
  try {
    return read();
  } catch {
    return '';
  }
}
