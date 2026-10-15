import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  SESSION_LIMITS,
  coachDayWeekdays,
  durationMinutes,
  sessionExerciseSlug,
  sessionStats,
  type CoachPlanInWorkouts,
  type LastTime,
  type LoggedSet,
  type SessionExercise,
  type WorkoutFeeling,
  type WorkoutPlanView,
  type WorkoutSessionSource,
  type WorkoutSessionSummary,
  type WorkoutSessionView,
} from '@got/shared';
import { civilDateFromPrisma } from '../common/time/gym-time';

/**
 * The wire shapes of workout sessions (feat/workout-sessions). Pure: the
 * service reads rows, this turns them into `WorkoutSessionView` and
 * `WorkoutSessionSummary` with the SAME shared `sessionStats` the phone runs,
 * so the numbers in history and on the Done screen can never disagree.
 *
 * Weight is stored in GRAMS and leaves as kilos; dates leave as civil
 * `yyyy-mm-dd`, instants as ISO strings.
 */

/** The session columns every view and summary is built from. */
export interface SessionRow {
  id: string;
  source: WorkoutSessionSource;
  planName: string;
  coachFirstName: string | null;
  coachLastName: string | null;
  dayTitle: string;
  weekday: number | null;
  exercises: Prisma.JsonValue;
  businessDate: Date;
  startedAt: Date;
  finishedAt: Date | null;
  feeling: WorkoutFeeling | null;
}

export const SESSION_SELECT = {
  id: true,
  source: true,
  planName: true,
  coachFirstName: true,
  coachLastName: true,
  dayTitle: true,
  weekday: true,
  exercises: true,
  businessDate: true,
  startedAt: true,
  finishedAt: true,
  feeling: true,
} as const;

/** A ticked set, as stored. */
export interface SetRow {
  exerciseIndex: number;
  setIndex: number;
  weightGrams: number | null;
  reps: number;
  completedAt: Date;
}

export const SET_SELECT = {
  exerciseIndex: true,
  setIndex: true,
  weightGrams: true,
  reps: true,
  completedAt: true,
} as const;

/** Sets in the order the session screen and "what you did" list them. */
export const SET_ORDER: Prisma.WorkoutSetLogOrderByWithRelationInput[] = [
  { exerciseIndex: 'asc' },
  { setIndex: 'asc' },
];

/**
 * One row of the "last time" query: a done set of the slug's most recent
 * earlier session. `date` is that session's civil business date, rendered by
 * the query itself (`to_char`) so nothing depends on how a raw DATE decodes.
 */
export interface LastTimeRow {
  slug: string;
  date: string;
  weightGrams: number | null;
  reps: number;
}

const PLAN_NAME_MAX = 60;
const DAY_TITLE_MAX = 40;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isWholeInRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * The stored snapshot, proven rather than cast. The CHECK only promises an
 * array of 1-12; anything else here means a row written around the API, and
 * the caller treats it as a session it cannot show.
 */
export function parseSnapshot(value: Prisma.JsonValue): SessionExercise[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length < 1 || value.length > SESSION_LIMITS.exercisesMax) return null;
  const out: SessionExercise[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { name, muscles, sets, reps, restSeconds, notes } = item;
    if (typeof name !== 'string' || name.trim() === '') return null;
    if (muscles !== null && typeof muscles !== 'string') return null;
    if (!isWholeInRange(sets, 1, SESSION_LIMITS.setsPerExerciseMax)) return null;
    if (typeof reps !== 'string') return null;
    if (!isWholeInRange(restSeconds, 0, 3600)) return null;
    if (notes !== undefined && typeof notes !== 'string') return null;
    const exercise: SessionExercise = { name, muscles, sets, reps, restSeconds };
    if (typeof notes === 'string') exercise.notes = notes;
    out.push(exercise);
  }
  return out;
}

/**
 * The key a set is stored under: the shared slug, or — for a name with no
 * latin letters or digits at all, whose slug is empty — a stable hash of the
 * name, so the set still satisfies `WorkoutSetLog_exerciseSlug_shape` and the
 * same name always meets its own history.
 */
export function storageSlug(name: string): string {
  const slug = sessionExerciseSlug({ name });
  if (slug !== '') return slug;
  const digest = createHash('sha1').update(name.trim().toLowerCase()).digest('hex');
  return `x-${digest.slice(0, 16)}`;
}

/** "Coach Ana's plan" — the coach's plan has no name of its own. */
export function coachPlanName(coach: { firstName: string } | null): string {
  if (coach === null || coach.firstName.trim() === '') return "Your coach's plan";
  const prefix = 'Coach ';
  const suffix = "'s plan";
  const room = PLAN_NAME_MAX - prefix.length - suffix.length;
  const first = coach.firstName.trim();
  return `${prefix}${first.length > room ? first.slice(0, room).trimEnd() : first}${suffix}`;
}

/** A day title that fits `WorkoutSession_dayTitle_length`: trimmed, clipped with an ellipsis. */
export function dayTitleOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= DAY_TITLE_MAX) return trimmed;
  return `${trimmed.slice(0, DAY_TITLE_MAX - 1).trimEnd()}…`;
}

const kg = (grams: number | null): number | null => (grams === null ? null : grams / 1000);

export function toLoggedSet(row: SetRow): LoggedSet {
  return {
    exerciseIndex: row.exerciseIndex,
    setIndex: row.setIndex,
    weightKg: kg(row.weightGrams),
    reps: row.reps,
    completedAt: row.completedAt.toISOString(),
  };
}

/** The "last time" rows, grouped by slug in the order the query returned them. */
export function lastTimesOf(rows: readonly LastTimeRow[]): Map<string, LastTime> {
  const map = new Map<string, LastTime>();
  for (const row of rows) {
    let entry = map.get(row.slug);
    if (entry === undefined) {
      entry = { date: row.date, sets: [] };
      map.set(row.slug, entry);
    }
    entry.sets.push({ weightKg: kg(row.weightGrams), reps: row.reps });
  }
  return map;
}

/** Exercise i's heaviest earlier weight in kilos, from the per-slug grams map. */
export function previousBestKg(
  exercises: readonly SessionExercise[],
  bestGrams: ReadonlyMap<string, number>,
): (number | null)[] {
  return exercises.map((exercise) => kg(bestGrams.get(storageSlug(exercise.name)) ?? null));
}

export function toSessionView(
  row: SessionRow,
  exercises: readonly SessionExercise[],
  sets: readonly SetRow[],
  lastTimes: ReadonlyMap<string, LastTime>,
  bestGrams: ReadonlyMap<string, number>,
): WorkoutSessionView {
  return {
    id: row.id,
    source: row.source,
    planName: row.planName,
    coach:
      row.coachFirstName === null || row.coachLastName === null
        ? null
        : { firstName: row.coachFirstName, lastName: row.coachLastName },
    dayTitle: row.dayTitle,
    weekday: row.weekday,
    businessDate: civilDateFromPrisma(row.businessDate),
    exercises: exercises.map((exercise) => {
      const slug = storageSlug(exercise.name);
      return {
        ...exercise,
        lastTime: lastTimes.get(slug) ?? null,
        bestKg: kg(bestGrams.get(slug) ?? null),
      };
    }),
    sets: sets.map(toLoggedSet),
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
    feeling: row.feeling,
  };
}

/**
 * The coach's plan as the Workouts page shows it: `isActive` when none of the
 * member's AI plans is (the coach's plan then drives Today), and each day's
 * weekday from its label so Today can find the day.
 */
export function toCoachPlanInWorkouts(
  view: WorkoutPlanView,
  isActive: boolean,
): CoachPlanInWorkouts {
  return { ...view, isActive, weekdays: coachDayWeekdays(view.plan) };
}

/** A FINISHED session's summary. `bestGrams` is each slug's heaviest weight before it. */
export function toSessionSummary(
  row: SessionRow,
  exercises: readonly SessionExercise[],
  sets: readonly SetRow[],
  bestGrams: ReadonlyMap<string, number>,
): WorkoutSessionSummary {
  if (row.finishedAt === null) {
    throw new Error(`workout session ${row.id} is open — it has no summary yet`);
  }
  const stats = sessionStats(
    exercises,
    sets.map((s) => ({
      exerciseIndex: s.exerciseIndex,
      weightKg: kg(s.weightGrams),
      reps: s.reps,
    })),
    previousBestKg(exercises, bestGrams),
  );
  return {
    id: row.id,
    source: row.source,
    planName: row.planName,
    dayTitle: row.dayTitle,
    businessDate: civilDateFromPrisma(row.businessDate),
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    durationMinutes: durationMinutes(row.startedAt, row.finishedAt),
    setsDone: stats.setsDone,
    exercisesDone: stats.exercisesDone,
    exerciseCount: exercises.length,
    volumeKg: stats.volumeKg,
    bests: stats.bests,
    perExercise: stats.perExercise,
    feeling: row.feeling,
  };
}
