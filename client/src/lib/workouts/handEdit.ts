import {
  parseMemberPlan,
  type MemberPlanBody,
  type ParseResult,
  type PlanGuidance,
} from '@got/shared';

/**
 * "Edit by hand": the plan as string fields the inputs can bind to, and the
 * way back through `parseMemberPlan` — the shared parser — so the errors a
 * member sees are the ones the server would raise, by the same path names.
 */

export interface ExerciseForm {
  name: string;
  muscles: string;
  sets: string;
  reps: string;
  restSeconds: string;
  notes: string;
}

export interface DayForm {
  weekday: number;
  title: string;
  focus: string;
  minutes: string;
  warmUp: string;
  coolDown: string;
  exercises: ExerciseForm[];
}

export interface PlanForm {
  summary: string;
  days: DayForm[];
  guidance: PlanGuidance[];
}

export function planToForm(plan: MemberPlanBody): PlanForm {
  return {
    summary: plan.summary,
    guidance: plan.guidance,
    days: plan.days.map((day) => ({
      weekday: day.weekday,
      title: day.title,
      focus: day.focus,
      minutes: String(day.minutes),
      warmUp: day.warmUp,
      coolDown: day.coolDown,
      exercises: day.exercises.map((e) => ({
        name: e.name,
        muscles: e.muscles,
        sets: String(e.sets),
        reps: e.reps,
        restSeconds: String(e.restSeconds),
        notes: e.notes ?? '',
      })),
    })),
  };
}

/** A whole number, or the raw text so the parser names the field. */
function numberOrText(value: string): number | string {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

export function formToBody(form: PlanForm): ParseResult<MemberPlanBody> {
  return parseMemberPlan({
    summary: form.summary,
    guidance: form.guidance,
    days: form.days.map((day) => ({
      weekday: day.weekday,
      title: day.title,
      focus: day.focus,
      minutes: numberOrText(day.minutes),
      warmUp: day.warmUp,
      coolDown: day.coolDown,
      exercises: day.exercises.map((e) => ({
        name: e.name,
        muscles: e.muscles,
        sets: numberOrText(e.sets),
        reps: e.reps,
        restSeconds: numberOrText(e.restSeconds),
        ...(e.notes.trim() === '' ? {} : { notes: e.notes }),
      })),
    })),
  });
}

const BLANK_EXERCISE: ExerciseForm = {
  name: '',
  muscles: '',
  sets: '3',
  reps: '10',
  restSeconds: '60',
  notes: '',
};

function withDay(form: PlanForm, dayIndex: number, update: (day: DayForm) => DayForm): PlanForm {
  const day = form.days[dayIndex];
  if (day === undefined) return form;
  const next = update(day);
  if (next === day) return form;
  return { ...form, days: form.days.map((d, i) => (i === dayIndex ? next : d)) };
}

export function updateDay(
  form: PlanForm,
  dayIndex: number,
  patch: Partial<Omit<DayForm, 'weekday' | 'exercises'>>,
): PlanForm {
  return withDay(form, dayIndex, (day) => ({ ...day, ...patch }));
}

export function updateExercise(
  form: PlanForm,
  dayIndex: number,
  exerciseIndex: number,
  patch: Partial<ExerciseForm>,
): PlanForm {
  return withDay(form, dayIndex, (day) => {
    if (day.exercises[exerciseIndex] === undefined) return day;
    return {
      ...day,
      exercises: day.exercises.map((e, i) => (i === exerciseIndex ? { ...e, ...patch } : e)),
    };
  });
}

export function addExercise(form: PlanForm, dayIndex: number): PlanForm {
  return withDay(form, dayIndex, (day) => ({
    ...day,
    exercises: [...day.exercises, { ...BLANK_EXERCISE }],
  }));
}

/** A day keeps at least one exercise — the parser refuses an empty day. */
export function removeExercise(form: PlanForm, dayIndex: number, exerciseIndex: number): PlanForm {
  return withDay(form, dayIndex, (day) => {
    if (day.exercises.length <= 1 || day.exercises[exerciseIndex] === undefined) return day;
    return { ...day, exercises: day.exercises.filter((_, i) => i !== exerciseIndex) };
  });
}
