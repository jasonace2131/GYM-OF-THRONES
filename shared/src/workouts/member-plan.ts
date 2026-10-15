/**
 * A member's own AI workout plan — the ONE schema every door into
 * `MemberWorkoutPlan.body` and `MemberWorkoutDraft.plan` goes through
 * (feat/member-workouts). Same discipline as `parseWorkoutPlan`: strict, every
 * error at once, messages name the path and the rule, never the value.
 */

import {
  WORKOUT_EASY_ON,
  WORKOUT_EXPERIENCE,
  WORKOUT_GOALS,
  WORKOUT_SESSION_MINUTES,
  WORKOUT_TIMES_OF_DAY,
  type WorkoutIntake,
} from './workouts.types';

export const WORKOUT_LIMITS = {
  summaryMax: 600,
  daysMax: 6,
  titleMax: 40,
  focusMax: 80,
  minutesMin: 15,
  minutesMax: 120,
  warmUpMax: 200,
  coolDownMax: 200,
  exercisesMax: 10,
  exerciseNameMax: 80,
  musclesMax: 60,
  setsMax: 10,
  repsMax: 20,
  restSecondsMax: 300,
  notesMax: 160,
  guidanceMin: 2,
  guidanceMax: 5,
  guidanceTitleMax: 30,
  guidanceBodyMax: 200,
  planNameMax: 60,
  goalNotesMax: 300,
  adjustRequestMax: 200,
} as const;

export interface MemberPlanExercise {
  name: string;
  /** "Legs · glutes" — what it trains, for the row's second line. */
  muscles: string;
  sets: number;
  /** Text: "8-12", "30 s", "AMRAP". */
  reps: string;
  restSeconds: number;
  notes?: string;
}

export interface MemberPlanDay {
  /** 0 = Sunday … 6 = Saturday. Unique within a plan. */
  weekday: number;
  /** "Full body A". */
  title: string;
  focus: string;
  minutes: number;
  warmUp: string;
  coolDown: string;
  exercises: MemberPlanExercise[];
}

export interface PlanGuidance {
  title: string;
  body: string;
}

export interface MemberPlanBody {
  summary: string;
  days: MemberPlanDay[];
  guidance: PlanGuidance[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

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

/** A trimmed string of 1..max characters, else null plus an error. */
function text(value: unknown, max: number, path: string, errors: string[]): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length < 1 || trimmed.length > max) {
    errors.push(`${path} must be 1-${max} characters.`);
    return null;
  }
  return trimmed;
}

function integer(
  value: unknown,
  min: number,
  max: number,
  path: string,
  errors: string[],
): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max)
    return value;
  errors.push(`${path} must be a whole number from ${min} to ${max}.`);
  return null;
}

/** Absent, null and blank all mean "none" and come back as undefined. */
function optionalText(
  value: unknown,
  max: number,
  path: string,
  errors: string[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = typeof value === 'string' ? value.trim() : null;
  if (trimmed === null || trimmed.length > max) {
    errors.push(`${path} must be at most ${max} characters.`);
    return undefined;
  }
  return trimmed === '' ? undefined : trimmed;
}

const EXERCISE_KEYS = ['name', 'muscles', 'sets', 'reps', 'restSeconds', 'notes'] as const;

export function parseMemberExercise(
  value: unknown,
  path: string,
  errors: string[],
): MemberPlanExercise | null {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an exercise.`);
    return null;
  }
  unexpected(value, EXERCISE_KEYS, path, errors);
  const name = text(value['name'], WORKOUT_LIMITS.exerciseNameMax, `${path}.name`, errors);
  const muscles = text(value['muscles'], WORKOUT_LIMITS.musclesMax, `${path}.muscles`, errors);
  const sets = integer(value['sets'], 1, WORKOUT_LIMITS.setsMax, `${path}.sets`, errors);
  // A model asked for text sometimes answers 12 rather than "12".
  const repsValue = value['reps'];
  const reps = text(
    typeof repsValue === 'number' && Number.isInteger(repsValue) && repsValue > 0
      ? String(repsValue)
      : repsValue,
    WORKOUT_LIMITS.repsMax,
    `${path}.reps`,
    errors,
  );
  const restSeconds = integer(
    value['restSeconds'],
    0,
    WORKOUT_LIMITS.restSecondsMax,
    `${path}.restSeconds`,
    errors,
  );
  const notes = optionalText(value['notes'], WORKOUT_LIMITS.notesMax, `${path}.notes`, errors);
  if (name === null || muscles === null || sets === null || reps === null || restSeconds === null)
    return null;
  return notes === undefined
    ? { name, muscles, sets, reps, restSeconds }
    : { name, muscles, sets, reps, restSeconds, notes };
}

const DAY_KEYS = [
  'weekday',
  'title',
  'focus',
  'minutes',
  'warmUp',
  'coolDown',
  'exercises',
] as const;

export function parseMemberDay(
  value: unknown,
  path: string,
  errors: string[],
): MemberPlanDay | null {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be a day.`);
    return null;
  }
  unexpected(value, DAY_KEYS, path, errors);
  const weekday = integer(value['weekday'], 0, 6, `${path}.weekday`, errors);
  const title = text(value['title'], WORKOUT_LIMITS.titleMax, `${path}.title`, errors);
  const focus = text(value['focus'], WORKOUT_LIMITS.focusMax, `${path}.focus`, errors);
  const minutes = integer(
    value['minutes'],
    WORKOUT_LIMITS.minutesMin,
    WORKOUT_LIMITS.minutesMax,
    `${path}.minutes`,
    errors,
  );
  const warmUp = text(value['warmUp'], WORKOUT_LIMITS.warmUpMax, `${path}.warmUp`, errors);
  const coolDown = text(value['coolDown'], WORKOUT_LIMITS.coolDownMax, `${path}.coolDown`, errors);

  const list = value['exercises'];
  if (!Array.isArray(list) || list.length < 1 || list.length > WORKOUT_LIMITS.exercisesMax) {
    errors.push(`${path}.exercises must hold 1-${WORKOUT_LIMITS.exercisesMax} exercises.`);
    return null;
  }
  const exercises = list.map((item, i) =>
    parseMemberExercise(item, `${path}.exercises[${i}]`, errors),
  );
  if (
    weekday === null ||
    title === null ||
    focus === null ||
    minutes === null ||
    warmUp === null ||
    coolDown === null ||
    exercises.some((e) => e === null)
  ) {
    return null;
  }
  return {
    weekday,
    title,
    focus,
    minutes,
    warmUp,
    coolDown,
    exercises: exercises as MemberPlanExercise[],
  };
}

const GUIDANCE_KEYS = ['title', 'body'] as const;

export function parseGuidance(
  value: unknown,
  path: string,
  errors: string[],
): PlanGuidance[] | null {
  if (
    !Array.isArray(value) ||
    value.length < WORKOUT_LIMITS.guidanceMin ||
    value.length > WORKOUT_LIMITS.guidanceMax
  ) {
    errors.push(
      `${path} must hold ${WORKOUT_LIMITS.guidanceMin}-${WORKOUT_LIMITS.guidanceMax} tips.`,
    );
    return null;
  }
  const tips = value.map((item, i) => {
    const p = `${path}[${i}]`;
    if (!isPlainObject(item)) {
      errors.push(`${p} must be a tip.`);
      return null;
    }
    unexpected(item, GUIDANCE_KEYS, p, errors);
    const title = text(item['title'], WORKOUT_LIMITS.guidanceTitleMax, `${p}.title`, errors);
    const body = text(item['body'], WORKOUT_LIMITS.guidanceBodyMax, `${p}.body`, errors);
    return title === null || body === null ? null : { title, body };
  });
  return tips.some((t) => t === null) ? null : (tips as PlanGuidance[]);
}

/**
 * Validates and NORMALISES a whole plan. Beyond the shape: 1-6 days and no two
 * on the same weekday — a plan is a week, and "Monday" twice is not one.
 */
export function parseMemberPlan(input: unknown): ParseResult<MemberPlanBody> {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['The plan must be an object with a summary, days and guidance.'] };
  }
  const errors: string[] = [];
  unexpected(input, ['summary', 'days', 'guidance'], '', errors);
  const summary = text(input['summary'], WORKOUT_LIMITS.summaryMax, 'summary', errors);

  const list = input['days'];
  let days: (MemberPlanDay | null)[] = [];
  if (!Array.isArray(list) || list.length < 1 || list.length > WORKOUT_LIMITS.daysMax) {
    errors.push(`days must hold 1-${WORKOUT_LIMITS.daysMax} days.`);
  } else {
    days = list.map((item, i) => parseMemberDay(item, `days[${i}]`, errors));
    const seen = new Set<number>();
    for (const day of days) {
      if (day === null) continue;
      if (seen.has(day.weekday))
        errors.push(`days: weekday ${day.weekday} appears more than once.`);
      seen.add(day.weekday);
    }
  }

  const guidance = parseGuidance(input['guidance'], 'guidance', errors);
  if (errors.length > 0 || summary === null || guidance === null) return { ok: false, errors };
  return { ok: true, value: { summary, days: days as MemberPlanDay[], guidance } };
}

const INTAKE_KEYS = [
  'goal',
  'goalNotes',
  'experience',
  'weekdays',
  'sessionMinutes',
  'timeOfDay',
  'healthFlag',
  'easyOn',
  'use',
  'consent',
] as const;

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: string[],
): T | null {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
    return value as T;
  errors.push(`${path} must be one of ${allowed.join(', ')}.`);
  return null;
}

function bool(value: unknown, path: string, errors: string[]): boolean | null {
  if (typeof value === 'boolean') return value;
  errors.push(`${path} must be true or false.`);
  return null;
}

/**
 * The wizard's final check and the DTO's semantic rules, in one place. The
 * server's class-validator DTO still declares the fields (the global
 * ValidationPipe whitelists), then hands the body here.
 */
export function parseWorkoutIntake(input: unknown): ParseResult<WorkoutIntake> {
  if (!isPlainObject(input)) return { ok: false, errors: ['The intake must be an object.'] };
  const errors: string[] = [];
  unexpected(input, INTAKE_KEYS, '', errors);

  const goal = oneOf(input['goal'], WORKOUT_GOALS, 'goal', errors);
  const goalNotes = optionalText(
    input['goalNotes'],
    WORKOUT_LIMITS.goalNotesMax,
    'goalNotes',
    errors,
  );
  const experience = oneOf(input['experience'], WORKOUT_EXPERIENCE, 'experience', errors);

  const rawDays = input['weekdays'];
  let weekdays: number[] | null = null;
  if (!Array.isArray(rawDays) || rawDays.length < 1 || rawDays.length > 7) {
    errors.push('weekdays must hold 1-7 days.');
  } else if (
    !rawDays.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)
  ) {
    errors.push('weekdays must be whole numbers from 0 (Sunday) to 6 (Saturday).');
  } else if (new Set(rawDays).size !== rawDays.length) {
    errors.push('weekdays must not repeat.');
  } else {
    weekdays = [...(rawDays as number[])].sort((a, b) => a - b);
  }

  const minutesValue = input['sessionMinutes'];
  const sessionMinutes = (WORKOUT_SESSION_MINUTES as readonly number[]).includes(
    minutesValue as number,
  )
    ? (minutesValue as WorkoutIntake['sessionMinutes'])
    : null;
  if (sessionMinutes === null)
    errors.push(`sessionMinutes must be one of ${WORKOUT_SESSION_MINUTES.join(', ')}.`);

  const timeOfDay = oneOf(input['timeOfDay'], WORKOUT_TIMES_OF_DAY, 'timeOfDay', errors);
  const healthFlag = bool(input['healthFlag'], 'healthFlag', errors);

  const rawEasy = input['easyOn'];
  let easyOn: WorkoutIntake['easyOn'] | null = null;
  if (!Array.isArray(rawEasy) || rawEasy.length > WORKOUT_EASY_ON.length) {
    errors.push(`easyOn must be a list of at most ${WORKOUT_EASY_ON.length} areas.`);
  } else if (!rawEasy.every((a) => (WORKOUT_EASY_ON as readonly string[]).includes(a as string))) {
    errors.push(`easyOn entries must be one of ${WORKOUT_EASY_ON.join(', ')}.`);
  } else if (new Set(rawEasy).size !== rawEasy.length) {
    errors.push('easyOn must not repeat.');
  } else {
    easyOn = rawEasy as WorkoutIntake['easyOn'];
  }

  let use: WorkoutIntake['use'] | null = null;
  const rawUse = input['use'];
  if (!isPlainObject(rawUse)) {
    errors.push('use must be an object with measurements, attendance and bookings.');
  } else {
    unexpected(rawUse, ['measurements', 'attendance', 'bookings'], 'use', errors);
    const m = bool(rawUse['measurements'], 'use.measurements', errors);
    const a = bool(rawUse['attendance'], 'use.attendance', errors);
    const b = bool(rawUse['bookings'], 'use.bookings', errors);
    if (m !== null && a !== null && b !== null)
      use = { measurements: m, attendance: a, bookings: b };
  }

  if (input['consent'] !== true) errors.push('consent must be true.');

  if (
    errors.length > 0 ||
    goal === null ||
    experience === null ||
    weekdays === null ||
    sessionMinutes === null ||
    timeOfDay === null ||
    healthFlag === null ||
    easyOn === null ||
    use === null
  ) {
    return { ok: false, errors };
  }
  const intake: WorkoutIntake = {
    goal,
    experience,
    weekdays,
    sessionMinutes,
    timeOfDay,
    healthFlag,
    easyOn,
    use,
    consent: true,
  };
  return { ok: true, value: goalNotes === undefined ? intake : { ...intake, goalNotes } };
}

/** "goblet-squat" — the ExerciseGuide cache key. Empty when nothing survives. */
export function exerciseSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
