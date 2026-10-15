import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { exerciseSlug, type ExerciseGuideView } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { GeminiGateway } from '../assistant/gemini-gateway.service';
import { ASK_BUDGET_MS, remainingMs } from '../assistant/assistant-budget';
import { generationConfigFor } from '../assistant/gemini-models';
import { UnusableReplyError, rotateForMember } from './member-workout-gemini';
import {
  GUIDE_RESPONSE_SCHEMA,
  GUIDE_SYSTEM_PROMPT,
  guidePrompt,
  parseGuideReply,
  readModelJson,
} from './member-plan-prompt';

export const EXERCISE_UNKNOWN_MESSAGE = 'That exercise is not in any of your plans.';

/** A guide is a few hundred tokens; this bounds a runaway. */
const GUIDE_MAX_OUTPUT_TOKENS = 1024;

/**
 * Every exercise name in a plan-shaped JSON value, lower-cased and trimmed.
 * Lenient on purpose: it walks a stored body or a draft's partial plan and
 * ignores anything that is not a named exercise.
 */
export function exerciseNamesOf(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  const days = (value as { days?: unknown }).days;
  if (!Array.isArray(days)) return [];
  const names: string[] = [];
  for (const day of days) {
    const exercises = (day as { exercises?: unknown } | null)?.exercises;
    if (!Array.isArray(exercises)) continue;
    for (const exercise of exercises) {
      const name = (exercise as { name?: unknown } | null)?.name;
      if (typeof name === 'string' && name.trim() !== '') names.push(name.trim().toLowerCase());
    }
  }
  return names;
}

/**
 * "How to do it" (feat/member-workouts).
 *
 * FREE, CACHED, SHARED — AND NEVER A GENERAL ENDPOINT. The name must occur
 * in one of the caller's own plans, their draft, their coach's plan or their
 * open workout, else 404: a member cannot use this to ask the model about
 * anything they like on the gym's quota.
 * The prompt is the exercise name and nothing else, which is what makes one
 * guide safe to serve to every member who has that exercise.
 */
@Injectable()
export class ExerciseGuidesService {
  private readonly logger = new Logger(ExerciseGuidesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gemini: GeminiGateway,
  ) {}

  async guide(memberId: string, exercise: string): Promise<ExerciseGuideView> {
    const name = exercise.trim();
    const slug = exerciseSlug(name);
    if (slug === '' || !(await this.isMembersExercise(memberId, name))) {
      throw new DomainException(
        'WORKOUT_EXERCISE_UNKNOWN',
        EXERCISE_UNKNOWN_MESSAGE,
        HttpStatus.NOT_FOUND,
      );
    }

    const cached = await this.prisma.exerciseGuide.findUnique({ where: { slug } });
    if (cached !== null) {
      const parsed = parseGuideReply(cached.body);
      if (parsed.ok) return { name: cached.name, ...parsed.value };
      this.logger.error(`exercise guide ${slug} fails the guide schema — regenerating`);
    }

    const prompt = guidePrompt(name);
    const { model, value, startedAt } = await rotateForMember(
      this.gemini,
      'exercise-guide',
      ASK_BUDGET_MS,
      async (modelName, context) => {
        const generative = context.client.getGenerativeModel({
          model: modelName,
          systemInstruction: GUIDE_SYSTEM_PROMPT,
          generationConfig: {
            ...generationConfigFor(modelName),
            maxOutputTokens: GUIDE_MAX_OUTPUT_TOKENS,
            responseMimeType: 'application/json',
            responseSchema: GUIDE_RESPONSE_SCHEMA,
          },
        });
        context.countRequest();
        const reply = await generative.generateContent(prompt, {
          timeout: remainingMs(context.deadline),
        });
        const parsed = parseGuideReply(readModelJson(safeText(() => reply.response.text())));
        if (!parsed.ok) throw new UnusableReplyError(`guide: ${parsed.errors.length} error(s)`);
        return parsed.value;
      },
    );

    // Two members asking for the same new exercise at once both write; the
    // first wins and the second's upsert is a no-op.
    await this.prisma.exerciseGuide.upsert({
      where: { slug },
      create: { slug, name, body: value as unknown as Prisma.InputJsonValue, model },
      update: {},
    });
    this.logger.log(`exercise-guide written model=${model} ms=${Date.now() - startedAt}`);
    return { name, ...value };
  }

  /**
   * Case-insensitive, trimmed, against the caller's own things only: their
   * plans, their draft, their coach's plan for them, and the snapshot of
   * their open workout (feat/workout-sessions) — whose exercises came from
   * one of the others but may have outlived an edit to it.
   */
  private async isMembersExercise(memberId: string, name: string): Promise<boolean> {
    const wanted = name.toLowerCase();
    const [plans, draft, coachPlan, openSession] = await Promise.all([
      this.prisma.memberWorkoutPlan.findMany({ where: { memberId }, select: { body: true } }),
      this.prisma.memberWorkoutDraft.findUnique({ where: { memberId }, select: { plan: true } }),
      this.prisma.workoutPlan.findUnique({ where: { memberId }, select: { body: true } }),
      this.prisma.workoutSession.findFirst({
        where: { memberId, finishedAt: null },
        select: { exercises: true },
      }),
    ]);
    const bodies: unknown[] = plans.map((plan) => plan.body);
    if (draft !== null) bodies.push(draft.plan);
    // The coach's body has the same days[].exercises[].name walk.
    if (coachPlan !== null) bodies.push(coachPlan.body);
    // A snapshot is a bare exercise list: give it the one-day shape the walk reads.
    if (openSession !== null) bodies.push({ days: [{ exercises: openSession.exercises }] });
    return bodies.some((body) => exerciseNamesOf(body).includes(wanted));
  }
}

function safeText(read: () => string): string {
  try {
    return read();
  } catch {
    return '';
  }
}
