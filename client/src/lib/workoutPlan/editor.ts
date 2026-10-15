import {
  WEEKDAY_LABELS,
  WORKOUT_PLAN_LIMITS,
  parseWorkoutPlan,
  weekdayFromLabel,
  type WorkoutPlanBody,
  type WorkoutPlanParse,
} from '@got/shared';

/**
 * The coach's workout-plan editor, as pure data operations (feat/coach-tools).
 *
 * Plain inputs, no rich text: every field is held as the STRING the input
 * shows, so a half-typed "1" or an emptied sets box is representable, and
 * turned into the wire body only at Save. Validation is `parseWorkoutPlan`
 * from @got/shared — the very function the server runs on the save — so the
 * editor can never accept what the API will refuse.
 *
 * Every row carries a `key` for React's list identity; keys are injected so
 * tests are deterministic.
 */

export interface DraftExercise {
  key: string;
  name: string;
  sets: string;
  reps: string;
  notes: string;
}

export interface DraftDay {
  key: string;
  day: string;
  focus: string;
  exercises: DraftExercise[];
}

export interface PlanDraft {
  summary: string;
  days: DraftDay[];
}

export type MakeKey = () => string;

export const randomKey: MakeKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

function blankExercise(makeKey: MakeKey): DraftExercise {
  return { key: makeKey(), name: '', sets: '3', reps: '10', notes: '' };
}

function blankDay(label: string, makeKey: MakeKey): DraftDay {
  const key = makeKey();
  return { key, day: label, focus: '', exercises: [blankExercise(makeKey)] };
}

export function emptyDraft(makeKey: MakeKey = randomKey): PlanDraft {
  return { summary: '', days: [blankDay('Day 1', makeKey)] };
}

export function draftFromPlan(plan: WorkoutPlanBody, makeKey: MakeKey = randomKey): PlanDraft {
  return {
    summary: plan.summary,
    days: plan.days.map((day) => {
      const key = makeKey();
      return {
        key,
        day: day.day,
        focus: day.focus,
        exercises: day.exercises.map((exercise) => ({
          key: makeKey(),
          name: exercise.name,
          sets: String(exercise.sets),
          reps: exercise.reps,
          notes: exercise.notes ?? '',
        })),
      };
    }),
  };
}

/**
 * The wire body. `sets` becomes a number only when the box holds a whole
 * number; anything else is sent as NaN so the schema names the field rather
 * than the editor guessing what was meant.
 */
export function draftToBody(draft: PlanDraft): unknown {
  return {
    summary: draft.summary,
    days: draft.days.map((day) => ({
      day: day.day,
      focus: day.focus,
      exercises: day.exercises.map((exercise) => {
        const sets = exercise.sets.trim();
        const base = {
          name: exercise.name,
          sets: /^\d+$/.test(sets) ? Number(sets) : Number.NaN,
          reps: exercise.reps,
        };
        return exercise.notes.trim() === '' ? base : { ...base, notes: exercise.notes };
      }),
    })),
  };
}

export function validateDraft(draft: PlanDraft): WorkoutPlanParse {
  return parseWorkoutPlan(draftToBody(draft));
}

export function addDay(draft: PlanDraft, makeKey: MakeKey = randomKey): PlanDraft {
  if (draft.days.length >= WORKOUT_PLAN_LIMITS.daysMax) return draft;
  return { ...draft, days: [...draft.days, blankDay(`Day ${draft.days.length + 1}`, makeKey)] };
}

/** A plan needs at least one day, so the last one stays. */
export function removeDay(draft: PlanDraft, dayKey: string): PlanDraft {
  if (draft.days.length <= 1) return draft;
  return { ...draft, days: draft.days.filter((day) => day.key !== dayKey) };
}

export function updateDay(
  draft: PlanDraft,
  dayKey: string,
  patch: Partial<Pick<DraftDay, 'day' | 'focus'>>,
): PlanDraft {
  return {
    ...draft,
    days: draft.days.map((day) => (day.key === dayKey ? { ...day, ...patch } : day)),
  };
}

export function addExercise(
  draft: PlanDraft,
  dayKey: string,
  makeKey: MakeKey = randomKey,
): PlanDraft {
  return {
    ...draft,
    days: draft.days.map((day) =>
      day.key === dayKey && day.exercises.length < WORKOUT_PLAN_LIMITS.exercisesMax
        ? { ...day, exercises: [...day.exercises, blankExercise(makeKey)] }
        : day,
    ),
  };
}

/** A day needs at least one exercise, so the last one stays. */
export function removeExercise(draft: PlanDraft, dayKey: string, exerciseKey: string): PlanDraft {
  const day = draft.days.find((d) => d.key === dayKey);
  if (day === undefined || day.exercises.length <= 1) return draft;
  return {
    ...draft,
    days: draft.days.map((d) =>
      d.key === dayKey ? { ...d, exercises: d.exercises.filter((e) => e.key !== exerciseKey) } : d,
    ),
  };
}

export function updateExercise(
  draft: PlanDraft,
  dayKey: string,
  exerciseKey: string,
  patch: Partial<Omit<DraftExercise, 'key'>>,
): PlanDraft {
  return {
    ...draft,
    days: draft.days.map((day) =>
      day.key === dayKey
        ? {
            ...day,
            exercises: day.exercises.map((e) => (e.key === exerciseKey ? { ...e, ...patch } : e)),
          }
        : day,
    ),
  };
}

/**
 * One schema error in the words a coach uses: "days[0].exercises[1].sets must
 * be…" becomes "Day 1, exercise 2: sets must be…". Anything it does not
 * recognise is returned with only its first letter raised.
 */
export function humanizeError(error: string): string {
  const exercise = /^days\[(\d+)\]\.exercises\[(\d+)\]\.?(.*)$/.exec(error);
  if (exercise !== null) {
    const [, day, index, rest] = exercise;
    return `Day ${Number(day) + 1}, exercise ${Number(index) + 1}: ${rest.replace(/^: /, '')}`;
  }
  const day = /^days\[(\d+)\]\.?(.*)$/.exec(error);
  if (day !== null) {
    const [, index, rest] = day;
    return `Day ${Number(index) + 1}: ${rest.replace(/^: /, '')}`;
  }
  return error.charAt(0).toUpperCase() + error.slice(1);
}

// ── The day label as a weekday picker (feat/workout-sessions) ──────────────
//
// The member's Today finds the coach's day by its label, and only a label
// that IS a weekday counts (`weekdayFromLabel`). So the label is a <select>
// of weekdays, with "Other…" revealing the old free-text box for plans that
// are not tied to days of the week. The label stays the single source of
// truth: the select is derived from it, never stored beside it.

export const OTHER_DAY = 'other';

/** Monday first, like every week the member sees; then "Other…". */
export const DAY_OPTIONS: readonly { value: string; label: string }[] = [
  ...[1, 2, 3, 4, 5, 6, 0].map((weekday) => ({
    value: String(weekday),
    label: WEEKDAY_LABELS[weekday] as string,
  })),
  { value: OTHER_DAY, label: 'Other…' },
];

/** The select's value for a label: its weekday ("1"), or "other". */
export function dayChoice(label: string): string {
  const weekday = weekdayFromLabel(label);
  return weekday === null ? OTHER_DAY : String(weekday);
}

/**
 * The label a choice writes. "Other…" keeps free text as it is, but empties a
 * weekday name — otherwise the label would still read "Monday" and the select
 * would snap straight back to it.
 */
export function labelForChoice(choice: string, current: string): string {
  if (choice === OTHER_DAY) return weekdayFromLabel(current) === null ? current : '';
  const weekday = Number(choice);
  return WEEKDAY_LABELS[weekday] ?? current;
}

/** Weekdays more than one day is labelled with — the member's Today uses the first. */
export function repeatedWeekdays(draft: PlanDraft): string[] {
  const counts = new Map<number, number>();
  for (const day of draft.days) {
    const weekday = weekdayFromLabel(day.day);
    if (weekday !== null) counts.set(weekday, (counts.get(weekday) ?? 0) + 1);
  }
  return [1, 2, 3, 4, 5, 6, 0]
    .filter((weekday) => (counts.get(weekday) ?? 0) > 1)
    .map((weekday) => WEEKDAY_LABELS[weekday] as string);
}

export function planTotals(plan: WorkoutPlanBody): { days: number; exercises: number } {
  return {
    days: plan.days.length,
    exercises: plan.days.reduce((sum, day) => sum + day.exercises.length, 0),
  };
}
