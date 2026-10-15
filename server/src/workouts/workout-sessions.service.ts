import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  SESSION_LIMITS,
  coachDayWeekdays,
  finishInstant,
  parseLogSetBody,
  parseMemberPlan,
  sessionExercisesFromCoachDay,
  sessionExercisesFromMemberDay,
  type FinishSessionBody,
  type LoggedSet,
  type PatchSessionBody,
  type SessionExercise,
  type StartSessionBody,
  type WorkoutSessionSource,
  type WorkoutSessionSummary,
  type WorkoutSessionView,
} from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { gymToday, toDateColumn } from '../common/time/gym-time';
import { WorkoutPlansService } from '../workout-plans/workout-plans.service';
import {
  SESSION_SELECT,
  SET_ORDER,
  SET_SELECT,
  coachPlanName,
  dayTitleOf,
  lastTimesOf,
  parseSnapshot,
  storageSlug,
  toLoggedSet,
  toSessionSummary,
  toSessionView,
  type LastTimeRow,
  type SessionRow,
  type SetRow,
} from './workout-sessions.presenter';

export const SESSION_OPEN_MESSAGE = 'You already have a workout going. Finish or discard it first.';
export const SESSION_STILL_OPEN_MESSAGE = 'This workout is still going. Finish it first.';
export const SESSION_MISSING_MESSAGE = 'That workout is not there any more.';
export const SESSION_FINISHED_MESSAGE = 'This workout is finished — its sets can no longer change.';
export const SESSION_EMPTY_MESSAGE = 'Tick at least one set to finish — or discard the workout.';
export const DAY_UNKNOWN_MESSAGE = 'That day is not in the plan any more.';
export const NO_COACH_PLAN_MESSAGE = 'Your coach has not saved a plan for you yet.';
export const SET_INVALID_MESSAGE = 'That set could not be saved — check the weight and reps.';

/** The session row as the lock reads it: only what a set write or finish decides on. */
interface LockedSession {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  exercises: unknown;
}

/** One target of the "best before" query: a session and the slugs it asks about. */
interface BestTarget {
  sessionId: string;
  startedAt: Date;
  slugs: string[];
}

type SessionWithSets = SessionRow & { sets: SetRow[] };

/** What a start writes, before it is a row. */
interface SessionDraft {
  source: WorkoutSessionSource;
  memberPlanId: string | null;
  coachPlanId: string | null;
  planName: string;
  coachFirstName: string | null;
  coachLastName: string | null;
  dayTitle: string;
  weekday: number | null;
  exercises: SessionExercise[];
}

const SESSION_WITH_SETS = {
  ...SESSION_SELECT,
  sets: { select: SET_SELECT, orderBy: SET_ORDER },
} as const;

/**
 * Workout sessions (feat/workout-sessions): the member's own workouts,
 * started from one day of one of their plans or of their coach's plan.
 *
 * KEYLESS AND HARD-CODED TO THE CALLER, like the rest of `/me/workouts`:
 * every read and write is `WHERE id AND memberId`, and an unscoped miss is
 * the same 404 as a session that never existed.
 *
 * ONE OPEN SESSION is `WorkoutSession_one_open` in the database. The start
 * inserts with ON CONFLICT DO NOTHING (`createMany({ skipDuplicates })`) and
 * branches on the count, OUTSIDE any transaction — never a caught unique
 * violation followed by another statement on the same transaction (25P02).
 *
 * SET WRITES AND FINISH SERIALISE on the session row (`SELECT … FOR UPDATE`),
 * so a tick replayed by the phone's offline queue can never land in a session
 * a finish has already summarised. Ticks are upserts and unticks deletes,
 * both keyed on (session, exercise, set): replaying either changes nothing.
 *
 * NEVER LOGS MEMBER DATA: counts and minutes only.
 */
@Injectable()
export class WorkoutSessionsService {
  private readonly logger = new Logger(WorkoutSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly coachPlans: WorkoutPlansService,
  ) {}

  // ── Start ────────────────────────────────────────────────────────────────

  /** `POST /me/workouts/sessions`. */
  async start(
    memberId: string,
    body: StartSessionBody,
    now: Date = new Date(),
  ): Promise<WorkoutSessionView> {
    const draft =
      body.source === 'MEMBER_PLAN'
        ? await this.memberDay(memberId, body.planId, body.weekday)
        : await this.coachDay(memberId, body.dayIndex);

    const id = randomUUID();
    const businessDate = toDateColumn(gymToday(now, this.gym.timeZone));
    const data: Prisma.WorkoutSessionCreateManyInput = {
      id,
      memberId,
      source: draft.source,
      memberPlanId: draft.memberPlanId,
      coachPlanId: draft.coachPlanId,
      planName: draft.planName,
      coachFirstName: draft.coachFirstName,
      coachLastName: draft.coachLastName,
      dayTitle: draft.dayTitle,
      weekday: draft.weekday,
      exercises: draft.exercises as unknown as Prisma.InputJsonValue,
      businessDate,
      startedAt: now,
    };

    // Twice at most: the open session we collided with may have been finished
    // or discarded between our insert and our look at it.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { count } = await this.prisma.workoutSession.createMany({
        data: [data],
        skipDuplicates: true,
      });
      if (count === 1) {
        this.logger.log(
          `workout-session started source=${draft.source} exercises=${draft.exercises.length} weekday=${draft.weekday ?? 'none'}`,
        );
        const row: SessionRow = {
          id,
          source: draft.source,
          planName: draft.planName,
          coachFirstName: draft.coachFirstName,
          coachLastName: draft.coachLastName,
          dayTitle: draft.dayTitle,
          weekday: draft.weekday,
          exercises: draft.exercises as unknown as Prisma.JsonValue,
          businessDate,
          startedAt: now,
          finishedAt: null,
          feeling: null,
        };
        return this.buildView(memberId, row, draft.exercises, []);
      }
      const open = await this.prisma.workoutSession.findFirst({
        where: { memberId, finishedAt: null },
        select: { id: true },
      });
      if (open !== null) throw sessionOpen(open.id, SESSION_OPEN_MESSAGE);
    }
    throw sessionOpen(null, SESSION_OPEN_MESSAGE);
  }

  /** A day of the caller's own plan, by weekday. */
  private async memberDay(
    memberId: string,
    planId: string,
    weekday: number,
  ): Promise<SessionDraft> {
    const plan = await this.prisma.memberWorkoutPlan.findFirst({
      where: { id: planId, memberId },
      select: { id: true, name: true, body: true },
    });
    if (plan === null) throw new NotFoundException('Plan not found');
    const parsed = parseMemberPlan(plan.body);
    if (!parsed.ok) {
      this.logger.error(`member workout plan ${plan.id} fails the plan schema — cannot start`);
      throw new NotFoundException('Plan not found');
    }
    const day = parsed.value.days.find((d) => d.weekday === weekday);
    if (day === undefined) throw dayUnknown(DAY_UNKNOWN_MESSAGE);
    return {
      source: 'MEMBER_PLAN',
      memberPlanId: plan.id,
      coachPlanId: null,
      planName: plan.name,
      coachFirstName: null,
      coachLastName: null,
      dayTitle: dayTitleOf(day.title),
      weekday: day.weekday,
      exercises: sessionExercisesFromMemberDay(day),
    };
  }

  /** A day of the caller's coach's plan, by position. */
  private async coachDay(memberId: string, dayIndex: number): Promise<SessionDraft> {
    const found = await this.coachPlans.planForMember(memberId);
    if (found === null) throw dayUnknown(NO_COACH_PLAN_MESSAGE);
    const { plan, coach } = found.view;
    const day = plan.days[dayIndex];
    if (day === undefined) throw dayUnknown(DAY_UNKNOWN_MESSAGE);
    return {
      source: 'COACH_PLAN',
      memberPlanId: null,
      coachPlanId: found.id,
      planName: coachPlanName(coach),
      coachFirstName: coach?.firstName ?? null,
      coachLastName: coach?.lastName ?? null,
      // The coach's label is (now) the weekday; the focus is what the day is.
      dayTitle: dayTitleOf(day.focus),
      weekday: coachDayWeekdays(plan)[dayIndex] ?? null,
      exercises: sessionExercisesFromCoachDay(day),
    };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** `GET /me/workouts/sessions/current` and the hub. */
  async current(memberId: string): Promise<WorkoutSessionView | null> {
    const row = await this.prisma.workoutSession.findFirst({
      where: { memberId, finishedAt: null },
      select: SESSION_WITH_SETS,
    });
    return row === null ? null : this.viewOf(memberId, row);
  }

  /** `GET /me/workouts/sessions/:id` — open or finished. */
  async get(memberId: string, id: string): Promise<WorkoutSessionView> {
    const row = await this.ownWithSets(memberId, id);
    const view = await this.viewOf(memberId, row);
    if (view === null) throw sessionMissing();
    return view;
  }

  /** `GET /me/workouts/sessions?limit=` — finished summaries, newest first. */
  async list(
    memberId: string,
    limit: number = SESSION_LIMITS.historyPageMax,
  ): Promise<WorkoutSessionSummary[]> {
    const max = SESSION_LIMITS.historyPageMax;
    const take = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), max) : max;
    const rows = await this.prisma.workoutSession.findMany({
      where: { memberId, finishedAt: { not: null } },
      orderBy: { startedAt: 'desc' },
      take,
      select: SESSION_WITH_SETS,
    });
    const usable = rows
      .map((row) => ({ row, exercises: this.snapshotOf(row) }))
      .filter(
        (item): item is { row: SessionWithSets; exercises: SessionExercise[] } =>
          item.exercises !== null,
      );
    const bests = await this.bestGramsBySession(
      memberId,
      usable.map(({ row, exercises }) => targetOf(row, exercises)),
    );
    return usable.map(({ row, exercises }) =>
      toSessionSummary(row, exercises, row.sets, bests.get(row.id) ?? new Map()),
    );
  }

  /** `GET /me/workouts/sessions/:id/summary` — a finished session only. */
  async summary(memberId: string, id: string): Promise<WorkoutSessionSummary> {
    const row = await this.ownWithSets(memberId, id);
    if (row.finishedAt === null) throw sessionOpen(row.id, SESSION_STILL_OPEN_MESSAGE);
    return this.summaryOf(memberId, row);
  }

  // ── Sets ─────────────────────────────────────────────────────────────────

  /** `PUT …/sets/:exerciseIndex/:setIndex` — tick (or re-tick with new numbers). */
  async logSet(
    memberId: string,
    id: string,
    exerciseIndexParam: string,
    setIndexParam: string,
    body: unknown,
    now: Date = new Date(),
  ): Promise<LoggedSet> {
    const { exerciseIndex, setIndex } = indexesOf(exerciseIndexParam, setIndexParam);
    const parsed = parseLogSetBody(body);
    if (!parsed.ok) throw setInvalid(parsed.errors);
    const { weightGrams, reps } = parsed.value;

    const row = await this.prisma.$transaction(async (tx) => {
      const exercises = await this.lockOpen(tx, memberId, id);
      const exercise = exercises[exerciseIndex];
      if (exercise === undefined) {
        throw setInvalid([`exerciseIndex must be below ${exercises.length} for this workout.`]);
      }
      return tx.workoutSetLog.upsert({
        where: { sessionId_exerciseIndex_setIndex: { sessionId: id, exerciseIndex, setIndex } },
        create: {
          sessionId: id,
          exerciseIndex,
          setIndex,
          memberId,
          exerciseName: exercise.name,
          exerciseSlug: storageSlug(exercise.name),
          weightGrams,
          reps,
          completedAt: now,
        },
        // The first tick's time stays: it is what "idle" and the duration read.
        update: { weightGrams, reps },
        select: SET_SELECT,
      });
    });
    return toLoggedSet(row);
  }

  /** `DELETE …/sets/:exerciseIndex/:setIndex` — untick. False when it was not ticked. */
  async unlogSet(
    memberId: string,
    id: string,
    exerciseIndexParam: string,
    setIndexParam: string,
  ): Promise<{ deleted: boolean }> {
    const { exerciseIndex, setIndex } = indexesOf(exerciseIndexParam, setIndexParam);
    return this.prisma.$transaction(async (tx) => {
      await this.lockOpen(tx, memberId, id);
      const { count } = await tx.workoutSetLog.deleteMany({
        where: { sessionId: id, exerciseIndex, setIndex },
      });
      return { deleted: count > 0 };
    });
  }

  // ── Finish, feeling, discard ─────────────────────────────────────────────

  /** `POST …/:id/finish`. A finished session answers its summary again. */
  async finish(
    memberId: string,
    id: string,
    body: FinishSessionBody,
    now: Date = new Date(),
  ): Promise<WorkoutSessionSummary> {
    const finished = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lock(tx, memberId, id);
      if (locked.finishedAt !== null) return null;
      const sets = await tx.workoutSetLog.findMany({
        where: { sessionId: id },
        select: SET_SELECT,
        orderBy: SET_ORDER,
      });
      if (sets.length === 0) {
        throw new DomainException(
          'WORKOUT_SESSION_EMPTY',
          SESSION_EMPTY_MESSAGE,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      const lastSetAt = sets.reduce(
        (latest, set) => (set.completedAt > latest ? set.completedAt : latest),
        sets[0].completedAt,
      );
      const at = finishInstant(lastSetAt, now);
      // Never before the start (WorkoutSession_finished_after_start), whatever the clocks did.
      const finishedAt = at < locked.startedAt ? locked.startedAt : at;
      const row = await tx.workoutSession.update({
        where: { id },
        data: { finishedAt, feeling: body.feeling ?? null },
        select: SESSION_SELECT,
      });
      return { row, sets, idle: finishedAt !== now };
    });

    if (finished === null) {
      return this.summaryOf(memberId, await this.ownWithSets(memberId, id));
    }
    const exercises = this.snapshotOf(finished.row);
    if (exercises === null) throw sessionMissing();
    const summary = toSessionSummary(
      finished.row,
      exercises,
      finished.sets,
      await this.bestGramsFor(memberId, targetOf(finished.row, exercises)),
    );
    this.logger.log(
      `workout-session finished sets=${summary.setsDone} exercises=${summary.exercisesDone}/${summary.exerciseCount} ` +
        `minutes=${summary.durationMinutes} idle=${finished.idle} bests=${summary.bests.length}`,
    );
    return summary;
  }

  /** `PATCH …/:id` — the feeling, on a finished session only. */
  async patch(
    memberId: string,
    id: string,
    body: PatchSessionBody,
  ): Promise<WorkoutSessionSummary> {
    const { count } = await this.prisma.workoutSession.updateMany({
      where: { id, memberId, finishedAt: { not: null } },
      data: { feeling: body.feeling },
    });
    if (count === 0) {
      const found = await this.prisma.workoutSession.findFirst({
        where: { id, memberId },
        select: { id: true, finishedAt: true },
      });
      if (found === null) throw sessionMissing();
      throw sessionOpen(found.id, SESSION_STILL_OPEN_MESSAGE);
    }
    return this.summary(memberId, id);
  }

  /** `DELETE …/:id` — discard an OPEN workout; its sets cascade. */
  async discard(memberId: string, id: string): Promise<{ id: string }> {
    const { count } = await this.prisma.workoutSession.deleteMany({
      where: { id, memberId, finishedAt: null },
    });
    if (count === 0) {
      const found = await this.prisma.workoutSession.findFirst({
        where: { id, memberId },
        select: { id: true, finishedAt: true },
      });
      if (found === null) throw sessionMissing();
      throw sessionFinished();
    }
    this.logger.log('workout-session discarded');
    return { id };
  }

  // ── Pieces ───────────────────────────────────────────────────────────────

  private async ownWithSets(memberId: string, id: string): Promise<SessionWithSets> {
    const row = await this.prisma.workoutSession.findFirst({
      where: { id, memberId },
      select: SESSION_WITH_SETS,
    });
    if (row === null) throw sessionMissing();
    return row;
  }

  /** The caller's session row, locked for the rest of the transaction; 404 if not theirs. */
  private async lock(
    tx: Prisma.TransactionClient,
    memberId: string,
    id: string,
  ): Promise<LockedSession> {
    const rows = await tx.$queryRaw<LockedSession[]>`
      SELECT "id", "startedAt", "finishedAt", "exercises"
        FROM "WorkoutSession"
       WHERE "id" = ${id}::uuid AND "memberId" = ${memberId}::uuid
         FOR UPDATE`;
    if (rows.length === 0) throw sessionMissing();
    return rows[0];
  }

  /** As `lock`, and the session must be open: its snapshot, for index checks. */
  private async lockOpen(
    tx: Prisma.TransactionClient,
    memberId: string,
    id: string,
  ): Promise<SessionExercise[]> {
    const locked = await this.lock(tx, memberId, id);
    if (locked.finishedAt !== null) throw sessionFinished();
    const exercises = parseSnapshot(locked.exercises as Prisma.JsonValue);
    if (exercises === null) {
      this.logger.error(`workout session ${locked.id} fails the snapshot shape — not written`);
      throw sessionMissing();
    }
    return exercises;
  }

  private snapshotOf(row: SessionRow): SessionExercise[] | null {
    const exercises = parseSnapshot(row.exercises);
    if (exercises === null) {
      this.logger.error(`workout session ${row.id} fails the snapshot shape — not shown`);
    }
    return exercises;
  }

  /** Null when the stored snapshot no longer passes the shape. */
  private async viewOf(memberId: string, row: SessionWithSets): Promise<WorkoutSessionView | null> {
    const exercises = this.snapshotOf(row);
    return exercises === null ? null : this.buildView(memberId, row, exercises, row.sets);
  }

  private async buildView(
    memberId: string,
    row: SessionRow,
    exercises: SessionExercise[],
    sets: SetRow[],
  ): Promise<WorkoutSessionView> {
    const target = targetOf(row, exercises);
    const [lastRows, bests] = await Promise.all([
      this.lastTimeRows(memberId, row.startedAt, target.slugs),
      this.bestGramsFor(memberId, target),
    ]);
    return toSessionView(row, exercises, sets, lastTimesOf(lastRows), bests);
  }

  private async summaryOf(memberId: string, row: SessionWithSets): Promise<WorkoutSessionSummary> {
    const exercises = this.snapshotOf(row);
    if (exercises === null) throw sessionMissing();
    const bests = await this.bestGramsFor(memberId, targetOf(row, exercises));
    return toSessionSummary(row, exercises, row.sets, bests);
  }

  /**
   * "Last time", for every slug at once: each slug's done sets in the member's
   * most recent FINISHED session that started before `before`. One query —
   * a lateral lookup per slug over the (memberId, exerciseSlug, …) index.
   */
  private async lastTimeRows(
    memberId: string,
    before: Date,
    slugs: string[],
  ): Promise<LastTimeRow[]> {
    if (slugs.length === 0) return [];
    return this.prisma.$queryRaw<LastTimeRow[]>`
      SELECT q."slug" AS "slug",
             to_char(p."businessDate", 'YYYY-MM-DD') AS "date",
             l."weightGrams" AS "weightGrams",
             l."reps" AS "reps"
        FROM unnest(${slugs}::text[]) AS q("slug")
        CROSS JOIN LATERAL (
          SELECT l2."sessionId"
            FROM "WorkoutSetLog" l2
            JOIN "WorkoutSession" p2 ON p2."id" = l2."sessionId"
           WHERE l2."memberId" = ${memberId}::uuid
             AND l2."exerciseSlug" = q."slug"
             AND p2."finishedAt" IS NOT NULL
             AND p2."startedAt" < ${before.toISOString()}::timestamptz
           ORDER BY p2."startedAt" DESC
           LIMIT 1
        ) AS last
        JOIN "WorkoutSession" p ON p."id" = last."sessionId"
        JOIN "WorkoutSetLog" l ON l."sessionId" = last."sessionId" AND l."exerciseSlug" = q."slug"
       ORDER BY q."slug", l."exerciseIndex", l."setIndex"`;
  }

  /**
   * "Best before", for many sessions and slugs at once: the heaviest weight
   * the member logged for each slug in finished sessions that started before
   * that session. One query for the whole page, never one per session or slug.
   */
  private async bestGramsBySession(
    memberId: string,
    targets: BestTarget[],
  ): Promise<Map<string, Map<string, number>>> {
    const ids: string[] = [];
    const starts: string[] = [];
    const slugs: string[] = [];
    for (const target of targets) {
      for (const slug of target.slugs) {
        ids.push(target.sessionId);
        starts.push(target.startedAt.toISOString());
        slugs.push(slug);
      }
    }
    const out = new Map<string, Map<string, number>>();
    if (slugs.length === 0) return out;

    const rows = await this.prisma.$queryRaw<
      Array<{ sessionId: string; slug: string; bestGrams: number | null }>
    >`
      SELECT q."sessionId"::text AS "sessionId",
             q."slug" AS "slug",
             (SELECT MAX(l."weightGrams")
                FROM "WorkoutSetLog" l
                JOIN "WorkoutSession" p ON p."id" = l."sessionId"
               WHERE l."memberId" = ${memberId}::uuid
                 AND l."exerciseSlug" = q."slug"
                 AND p."finishedAt" IS NOT NULL
                 AND p."startedAt" < q."startedAt") AS "bestGrams"
        FROM unnest(${ids}::uuid[], ${starts}::timestamptz[], ${slugs}::text[])
             AS q("sessionId", "startedAt", "slug")`;

    for (const row of rows) {
      if (row.bestGrams === null) continue;
      const bySlug = out.get(row.sessionId) ?? new Map<string, number>();
      bySlug.set(row.slug, Number(row.bestGrams));
      out.set(row.sessionId, bySlug);
    }
    return out;
  }

  /** One session's "best before", keyed by slug. */
  private async bestGramsFor(memberId: string, target: BestTarget): Promise<Map<string, number>> {
    const bySession = await this.bestGramsBySession(memberId, [target]);
    // Every row belongs to the one target, so merge them by slug.
    const merged = new Map<string, number>();
    for (const bySlug of bySession.values()) {
      for (const [slug, grams] of bySlug) merged.set(slug, grams);
    }
    return merged;
  }
}

/** The distinct storage slugs of a snapshot, for the two history queries. */
function targetOf(
  row: Pick<SessionRow, 'id' | 'startedAt'>,
  exercises: SessionExercise[],
): BestTarget {
  return {
    sessionId: row.id,
    startedAt: row.startedAt,
    slugs: [...new Set(exercises.map((exercise) => storageSlug(exercise.name)))],
  };
}

/** Path indexes as whole numbers within the session limits, else 400. */
function indexesOf(
  exerciseIndexParam: string,
  setIndexParam: string,
): { exerciseIndex: number; setIndex: number } {
  const exerciseIndex = wholeBelow(exerciseIndexParam, SESSION_LIMITS.exercisesMax);
  const setIndex = wholeBelow(setIndexParam, SESSION_LIMITS.setsPerExerciseMax);
  const errors: string[] = [];
  if (exerciseIndex === null) {
    errors.push(
      `exerciseIndex must be a whole number from 0 to ${SESSION_LIMITS.exercisesMax - 1}.`,
    );
  }
  if (setIndex === null) {
    errors.push(
      `setIndex must be a whole number from 0 to ${SESSION_LIMITS.setsPerExerciseMax - 1}.`,
    );
  }
  if (exerciseIndex === null || setIndex === null) throw setInvalid(errors);
  return { exerciseIndex, setIndex };
}

function wholeBelow(value: string, limit: number): number | null {
  if (!/^\d{1,3}$/.test(value)) return null;
  const n = Number(value);
  return n < limit ? n : null;
}

function sessionOpen(sessionId: string | null, message: string): DomainException {
  return new DomainException('WORKOUT_SESSION_OPEN', message, HttpStatus.CONFLICT, { sessionId });
}

function sessionMissing(): DomainException {
  return new DomainException(
    'WORKOUT_SESSION_MISSING',
    SESSION_MISSING_MESSAGE,
    HttpStatus.NOT_FOUND,
  );
}

function sessionFinished(): DomainException {
  return new DomainException(
    'WORKOUT_SESSION_FINISHED',
    SESSION_FINISHED_MESSAGE,
    HttpStatus.CONFLICT,
  );
}

function dayUnknown(message: string): DomainException {
  return new DomainException('WORKOUT_DAY_UNKNOWN', message, HttpStatus.NOT_FOUND);
}

function setInvalid(errors: string[]): DomainException {
  return new DomainException('WORKOUT_SET_INVALID', SET_INVALID_MESSAGE, HttpStatus.BAD_REQUEST, {
    errors,
  });
}
