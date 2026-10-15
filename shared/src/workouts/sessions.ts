/**
 * Workout sessions — "Start today's workout" as a real in-gym session, and the
 * coach's plan as a first-class plan in the member's Workouts page
 * (feat/workout-sessions). Spec:
 * docs/superpowers/specs/2026-09-29-workout-sessions-design.md.
 *
 * Everything here is pure and shared: the server snapshots and summarises with
 * these functions, and the session screen computes its live progress with the
 * same ones, so the numbers on the phone and in history can never disagree.
 */

import type { WorkoutPlanBody, WorkoutPlanView } from '../coaching/workout-plan';
import { exerciseSlug, type MemberPlanDay, type ParseResult } from './member-plan';

// ── Limits ──────────────────────────────────────────────────────────────────

export const SESSION_LIMITS = {
  /** A session snapshots one day: at most this many exercises. */
  exercisesMax: 12,
  /** Sets a member may log for one exercise, planned ones included. */
  setsPerExerciseMax: 20,
  weightKgMax: 500,
  repsMax: 200,
  /** How many finished sessions the hub shows. */
  recentOnHub: 5,
  /** History page size. */
  historyPageMax: 50,
} as const;

/** Rest for an exercise that came from a coach's plan, which records none. */
export const DEFAULT_REST_SECONDS = 90;

/**
 * A session left open this long after its last ticked set is finished AT that
 * set (plus nothing) rather than at "now", so a forgotten session does not
 * claim a 14-hour workout.
 */
export const SESSION_IDLE_CLOSE_MS = 2 * 60 * 60 * 1000;

export type WorkoutSessionSource = 'MEMBER_PLAN' | 'COACH_PLAN';

export const WORKOUT_FEELINGS = ['EASY', 'RIGHT', 'HARD'] as const;
export type WorkoutFeeling = (typeof WORKOUT_FEELINGS)[number];

// ── Snapshots ───────────────────────────────────────────────────────────────

/**
 * One exercise as the session froze it. Editing or deleting the plan later
 * never rewrites a finished workout.
 */
export interface SessionExercise {
  name: string;
  /** Null for a coach's plan, which records no muscles. */
  muscles: string | null;
  sets: number;
  /** Text, as in the plan: "8-12", "30 s". */
  reps: string;
  restSeconds: number;
  notes?: string;
}

export function sessionExercisesFromMemberDay(day: MemberPlanDay): SessionExercise[] {
  return day.exercises.slice(0, SESSION_LIMITS.exercisesMax).map((e) => {
    const out: SessionExercise = {
      name: e.name,
      muscles: e.muscles,
      sets: e.sets,
      reps: e.reps,
      restSeconds: e.restSeconds,
    };
    if (e.notes !== undefined) out.notes = e.notes;
    return out;
  });
}

export function sessionExercisesFromCoachDay(
  day: WorkoutPlanBody['days'][number],
): SessionExercise[] {
  return day.exercises.slice(0, SESSION_LIMITS.exercisesMax).map((e) => {
    const out: SessionExercise = {
      name: e.name,
      muscles: null,
      sets: e.sets,
      reps: e.reps,
      restSeconds: DEFAULT_REST_SECONDS,
    };
    if (e.notes !== undefined) out.notes = e.notes;
    return out;
  });
}

/** The first whole number in a reps text — "8-12" → 8, "30 s" → 30, "AMRAP" → null. */
export function targetReps(reps: string): number | null {
  const match = /\d+/.exec(reps);
  if (match === null) return null;
  const value = Number(match[0]);
  return value >= 1 && value <= SESSION_LIMITS.repsMax ? value : null;
}

// ── The coach's day labels ──────────────────────────────────────────────────

/**
 * Weekday names a coach might type, English and Filipino, full and short.
 * 0 = Sunday … 6 = Saturday, like OpeningHours and the member's own plans.
 */
const WEEKDAY_NAMES: readonly (readonly string[])[] = [
  ['sunday', 'sun', 'linggo'],
  ['monday', 'mon', 'lunes'],
  ['tuesday', 'tue', 'tues', 'martes'],
  ['wednesday', 'wed', 'miyerkules', 'miyerkoles'],
  ['thursday', 'thu', 'thur', 'thurs', 'huwebes'],
  ['friday', 'fri', 'biyernes'],
  ['saturday', 'sat', 'sabado'],
];

/**
 * The weekday a coach's day label names, or null. Only a label that IS a
 * weekday counts — "Monday", "mon.", "Lunes" — never one that merely contains
 * one ("Monday or Tuesday", "Day 1"), because guessing puts the wrong session
 * on the member's Today.
 */
export function weekdayFromLabel(label: string): number | null {
  const cleaned = label
    .trim()
    .toLowerCase()
    .replace(/[.,:;!]+$/, '');
  for (let day = 0; day < WEEKDAY_NAMES.length; day += 1) {
    if (WEEKDAY_NAMES[day].includes(cleaned)) return day;
  }
  return null;
}

export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * Each coach day's weekday, or null where the label names none. A weekday used
 * twice keeps only its FIRST day, so Today never has two sessions to choose
 * between without saying so.
 */
export function coachDayWeekdays(plan: WorkoutPlanBody): (number | null)[] {
  const seen = new Set<number>();
  return plan.days.map((day) => {
    const weekday = weekdayFromLabel(day.day);
    if (weekday === null || seen.has(weekday)) return null;
    seen.add(weekday);
    return weekday;
  });
}

// ── Logged sets ─────────────────────────────────────────────────────────────

/** A set the member ticked. Unticking deletes it — only done sets exist. */
export interface LoggedSet {
  exerciseIndex: number;
  setIndex: number;
  /** Null = bodyweight. */
  weightKg: number | null;
  reps: number;
  completedAt: string;
}

/** `PUT /me/workouts/sessions/:id/sets/:exerciseIndex/:setIndex`. */
export interface LogSetBody {
  weightKg: number | null;
  reps: number;
}

/**
 * Weight in kg with at most two decimals (17.5, 22.25), 0 < w ≤ 500, or null
 * for bodyweight; reps a whole number 1-200. Returns grams for storage, so the
 * database never holds a float.
 */
export function parseLogSetBody(
  input: unknown,
): ParseResult<{ weightGrams: number | null; reps: number }> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['The set must be an object with weightKg and reps.'] };
  }
  const body = input as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(body)) {
    if (key !== 'weightKg' && key !== 'reps') errors.push(`Unexpected field "${key}".`);
  }

  let weightGrams: number | null = null;
  const weight = body['weightKg'];
  if (weight !== null) {
    if (
      typeof weight !== 'number' ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      weight > SESSION_LIMITS.weightKgMax ||
      Math.abs(Math.round(weight * 100) - weight * 100) > 1e-6
    ) {
      errors.push(
        `weightKg must be null (bodyweight) or a number above 0 and at most ${SESSION_LIMITS.weightKgMax}, with at most two decimals.`,
      );
    } else {
      weightGrams = Math.round(weight * 1000);
    }
  }

  const reps = body['reps'];
  if (
    typeof reps !== 'number' ||
    !Number.isInteger(reps) ||
    reps < 1 ||
    reps > SESSION_LIMITS.repsMax
  ) {
    errors.push(`reps must be a whole number from 1 to ${SESSION_LIMITS.repsMax}.`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { weightGrams, reps: reps as number } };
}

// ── Views ───────────────────────────────────────────────────────────────────

/** What this member did on this exercise the last time it was logged. */
export interface LastTime {
  /** Civil date of that session. */
  date: string;
  /** Every done set of that exercise in that session, in order. */
  sets: { weightKg: number | null; reps: number }[];
}

export interface SessionExerciseView extends SessionExercise {
  /** Null when the member has never logged this exercise. */
  lastTime: LastTime | null;
  /** Heaviest weight ever logged for it before this session; null if none. */
  bestKg: number | null;
}

export interface WorkoutSessionView {
  id: string;
  source: WorkoutSessionSource;
  /** Snapshot of the plan's name ("Strength base", "Beginner Muscle"). */
  planName: string;
  /** The coach's first and last name when the source is the coach's plan. */
  coach: { firstName: string; lastName: string } | null;
  dayTitle: string;
  weekday: number | null;
  businessDate: string;
  exercises: SessionExerciseView[];
  sets: LoggedSet[];
  startedAt: string;
  finishedAt: string | null;
  feeling: WorkoutFeeling | null;
}

export interface NewBest {
  exerciseName: string;
  weightKg: number;
  reps: number;
  /** The previous best; a first-ever log is not a "new best". */
  previousKg: number;
}

export interface SessionExerciseSummary {
  name: string;
  setsDone: number;
  plannedSets: number;
  /** The heaviest set by weight, then by reps. Null if nothing was done. */
  top: { weightKg: number | null; reps: number } | null;
}

export interface WorkoutSessionSummary {
  id: string;
  source: WorkoutSessionSource;
  planName: string;
  dayTitle: string;
  businessDate: string;
  startedAt: string;
  finishedAt: string;
  durationMinutes: number;
  setsDone: number;
  exercisesDone: number;
  exerciseCount: number;
  /** Sum of weight × reps over weighted sets, in kg, rounded to a whole kg. */
  volumeKg: number;
  bests: NewBest[];
  perExercise: SessionExerciseSummary[];
  feeling: WorkoutFeeling | null;
}

/** `POST /me/workouts/sessions` — start a day from one of the member's plans or the coach's. */
export type StartSessionBody =
  | { source: 'MEMBER_PLAN'; planId: string; weekday: number }
  | { source: 'COACH_PLAN'; dayIndex: number };

export interface FinishSessionBody {
  feeling?: WorkoutFeeling;
}

export interface PatchSessionBody {
  feeling: WorkoutFeeling | null;
}

/** The coach's plan, as the Workouts page shows it. */
export interface CoachPlanInWorkouts extends WorkoutPlanView {
  /** True when no AI plan of the member's is active — the coach's plan drives Today. */
  isActive: boolean;
  /** `coachDayWeekdays(plan)` — each day's weekday or null. */
  weekdays: (number | null)[];
}

// ── Stats ───────────────────────────────────────────────────────────────────

/**
 * The live progress on the phone and the summary in history, from the same
 * rule. `previousBestKg[i]` is exercise i's heaviest logged weight before this
 * session (null if never), which is what decides a new best.
 */
export function sessionStats(
  exercises: readonly SessionExercise[],
  sets: readonly Pick<LoggedSet, 'exerciseIndex' | 'weightKg' | 'reps'>[],
  previousBestKg: readonly (number | null)[],
): {
  setsDone: number;
  exercisesDone: number;
  volumeKg: number;
  perExercise: SessionExerciseSummary[];
  bests: NewBest[];
} {
  const perExercise: SessionExerciseSummary[] = exercises.map((exercise, index) => {
    const mine = sets.filter((s) => s.exerciseIndex === index);
    let top: SessionExerciseSummary['top'] = null;
    for (const s of mine) {
      if (
        top === null ||
        (s.weightKg ?? 0) > (top.weightKg ?? 0) ||
        ((s.weightKg ?? 0) === (top.weightKg ?? 0) && s.reps > top.reps)
      ) {
        top = { weightKg: s.weightKg, reps: s.reps };
      }
    }
    return { name: exercise.name, setsDone: mine.length, plannedSets: exercise.sets, top };
  });

  const bests: NewBest[] = [];
  perExercise.forEach((summary, index) => {
    const previous = previousBestKg[index] ?? null;
    const topKg = summary.top?.weightKg ?? null;
    if (previous !== null && topKg !== null && topKg > previous && summary.top !== null) {
      bests.push({
        exerciseName: summary.name,
        weightKg: topKg,
        reps: summary.top.reps,
        previousKg: previous,
      });
    }
  });

  const grams = sets.reduce(
    (sum, s) => sum + (s.weightKg === null ? 0 : Math.round(s.weightKg * 1000) * s.reps),
    0,
  );

  return {
    setsDone: sets.length,
    exercisesDone: perExercise.filter((p) => p.setsDone > 0).length,
    volumeKg: Math.round(grams / 1000),
    perExercise,
    bests,
  };
}

/**
 * When an open session is finished: now, unless it sat idle — then the moment
 * of its last ticked set. With nothing ticked it cannot be finished at all
 * (the server answers WORKOUT_SESSION_EMPTY), so this is only asked with ≥ 1 set.
 */
export function finishInstant(lastSetAt: Date, now: Date): Date {
  return now.getTime() - lastSetAt.getTime() > SESSION_IDLE_CLOSE_MS ? lastSetAt : now;
}

/** Whole minutes, never below 1 for a finished session. */
export function durationMinutes(startedAt: Date, finishedAt: Date): number {
  return Math.max(1, Math.round((finishedAt.getTime() - startedAt.getTime()) / 60_000));
}

/** The ExerciseGuide/`lastTime` key for a snapshot exercise. */
export function sessionExerciseSlug(exercise: Pick<SessionExercise, 'name'>): string {
  return exerciseSlug(exercise.name);
}
