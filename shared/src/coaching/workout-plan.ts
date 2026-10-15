/**
 * A member's workout plan — the ONE schema both doors into `WorkoutPlan.body`
 * go through (feat/coach-tools).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO DOORS, ONE CHECK, TWO RUNTIMES.
 *
 * - The AI's reply to "Suggest a plan". A language model asked for JSON can
 *   still return the wrong shape, a 40-exercise day or a field nobody asked
 *   for; its reply is a DRAFT until this accepts it.
 * - The coach's Save (`PUT …/workout-plan`), which carries whatever the
 *   editor produced.
 *
 * The server runs this on both; the coach's editor runs the same function
 * before it lets them press Save, so the screen and the API can never
 * disagree about what a plan is. `WorkoutPlan_body_shape` in the database is
 * the floor under it (an object with a days array).
 *
 * STRICT: an unknown field is an error, at every level — a plan body is
 * rendered to a member, and nothing unvalidated should ride along inside it.
 * Messages name the PATH and the RULE, never the rejected value.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const WORKOUT_PLAN_LIMITS = {
  summaryMax: 600,
  daysMax: 7,
  dayLabelMax: 40,
  focusMax: 80,
  exercisesMax: 12,
  exerciseNameMax: 80,
  setsMax: 10,
  repsMax: 20,
  notesMax: 200,
} as const;

export interface WorkoutExercise {
  name: string;
  /** Whole sets, 1-10. */
  sets: number;
  /** Text, because "8-12", "30s" and "AMRAP" are all reps. */
  reps: string;
  notes?: string;
}

export interface WorkoutDay {
  /** "Monday", "Day 1" — the coach's own label. */
  day: string;
  focus: string;
  exercises: WorkoutExercise[];
}

export interface WorkoutPlanBody {
  summary: string;
  days: WorkoutDay[];
}

/**
 * A saved plan on the wire: `GET /me/workout-plan` (the member) and
 * `GET /me/coaching/members/:id/workout-plan` (their coach), each as
 * `{ plan: WorkoutPlanView | null }`.
 */
export interface WorkoutPlanView {
  plan: WorkoutPlanBody;
  /** Who wrote it. NULL if that account has since been removed. */
  coach: { firstName: string; lastName: string } | null;
  updatedAt: string;
}

/** `POST …/workout-plan/suggest`: an unsaved draft for the coach to edit. */
export interface WorkoutPlanSuggestion {
  draft: WorkoutPlanBody;
}

export type WorkoutPlanParse =
  { ok: true; plan: WorkoutPlanBody } | { ok: false; errors: string[] };

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unexpected(
  value: Json,
  allowed: readonly string[],
  where: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(
        where === '' ? `Unexpected field "${key}".` : `${where}: unexpected field "${key}".`,
      );
    }
  }
}

/** A trimmed string of 1..max characters, or null (and an error). */
function text(value: unknown, max: number, path: string, errors: string[]): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length < 1 || trimmed.length > max) {
    errors.push(`${path} must be 1-${max} characters.`);
    return null;
  }
  return trimmed;
}

const DAY_KEYS = ['day', 'focus', 'exercises'] as const;
const EXERCISE_KEYS = ['name', 'sets', 'reps', 'notes'] as const;

function parseExercise(value: unknown, path: string, errors: string[]): WorkoutExercise | null {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an exercise.`);
    return null;
  }
  unexpected(value, EXERCISE_KEYS, path, errors);

  const name = text(value['name'], WORKOUT_PLAN_LIMITS.exerciseNameMax, `${path}.name`, errors);

  const setsValue = value['sets'];
  const sets =
    typeof setsValue === 'number' &&
    Number.isInteger(setsValue) &&
    setsValue >= 1 &&
    setsValue <= WORKOUT_PLAN_LIMITS.setsMax
      ? setsValue
      : null;
  if (sets === null) {
    errors.push(`${path}.sets must be a whole number from 1 to ${WORKOUT_PLAN_LIMITS.setsMax}.`);
  }

  // A model asked for text sometimes answers 12 rather than "12". A whole
  // positive number means exactly one thing, so it is accepted as its text.
  const repsValue = value['reps'];
  const reps = text(
    typeof repsValue === 'number' && Number.isInteger(repsValue) && repsValue > 0
      ? String(repsValue)
      : repsValue,
    WORKOUT_PLAN_LIMITS.repsMax,
    `${path}.reps`,
    errors,
  );

  // Optional. Absent, null and blank all mean "no notes" and are stored as
  // absent — never as "".
  const notesValue = value['notes'];
  let notes: string | undefined;
  if (notesValue !== undefined && notesValue !== null) {
    const trimmed = typeof notesValue === 'string' ? notesValue.trim() : null;
    if (trimmed === null || trimmed.length > WORKOUT_PLAN_LIMITS.notesMax) {
      errors.push(`${path}.notes must be at most ${WORKOUT_PLAN_LIMITS.notesMax} characters.`);
    } else if (trimmed !== '') {
      notes = trimmed;
    }
  }

  if (name === null || sets === null || reps === null) return null;
  return notes === undefined ? { name, sets, reps } : { name, sets, reps, notes };
}

function parseDay(value: unknown, path: string, errors: string[]): WorkoutDay | null {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be a day.`);
    return null;
  }
  unexpected(value, DAY_KEYS, path, errors);

  const day = text(value['day'], WORKOUT_PLAN_LIMITS.dayLabelMax, `${path}.day`, errors);
  const focus = text(value['focus'], WORKOUT_PLAN_LIMITS.focusMax, `${path}.focus`, errors);

  const list = value['exercises'];
  if (!Array.isArray(list) || list.length < 1 || list.length > WORKOUT_PLAN_LIMITS.exercisesMax) {
    errors.push(`${path}.exercises must hold 1-${WORKOUT_PLAN_LIMITS.exercisesMax} exercises.`);
    return null;
  }
  const exercises = list.map((item, index) =>
    parseExercise(item, `${path}.exercises[${index}]`, errors),
  );

  if (day === null || focus === null || exercises.some((e) => e === null)) return null;
  return { day, focus, exercises: exercises as WorkoutExercise[] };
}

/**
 * Validates and NORMALISES a plan: every string trimmed, blank notes dropped,
 * whole-number reps turned into text. Returns every error found, not the first,
 * so the editor can show them all at once.
 */
export function parseWorkoutPlan(input: unknown): WorkoutPlanParse {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['The plan must be an object with a summary and days.'] };
  }

  const errors: string[] = [];
  unexpected(input, ['summary', 'days'], '', errors);

  const summary = text(input['summary'], WORKOUT_PLAN_LIMITS.summaryMax, 'summary', errors);

  const list = input['days'];
  let days: (WorkoutDay | null)[] = [];
  if (!Array.isArray(list) || list.length < 1 || list.length > WORKOUT_PLAN_LIMITS.daysMax) {
    errors.push(`days must hold 1-${WORKOUT_PLAN_LIMITS.daysMax} days.`);
  } else {
    days = list.map((item, index) => parseDay(item, `days[${index}]`, errors));
  }

  if (errors.length > 0 || summary === null) return { ok: false, errors };
  return { ok: true, plan: { summary, days: days as WorkoutDay[] } };
}
