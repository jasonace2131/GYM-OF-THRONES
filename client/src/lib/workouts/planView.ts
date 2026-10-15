import type {
  MemberPlanBody,
  MemberPlanDay,
  MemberPlanExercise,
  MemberWorkoutPlanView,
  WorkoutIntakeSummary,
} from '@got/shared';
import { GYM_TIMEZONE } from '@/lib/gymTime';
import {
  GOAL_LABEL,
  LEVEL_LABEL,
  TIME_LABEL,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  WEEK_ORDER,
  easyOnPhrase,
  weekdayList,
} from './labels';

/**
 * How a plan is written on screen — the mockup's exact phrasing, so the hub,
 * the draft, the saved plan and the dashboard card all read alike.
 */

/** "10-12" → "10–12": an en dash between numbers, as the mockups set it. */
export function repsText(reps: string): string {
  return reps.replace(/(\d)\s*-\s*(\d)/g, '$1–$2');
}

export function dose(exercise: Pick<MemberPlanExercise, 'sets' | 'reps'>): string {
  return `${exercise.sets} × ${repsText(exercise.reps)}`;
}

export function restLabel(restSeconds: number): string {
  if (restSeconds <= 0) return 'No rest';
  if (restSeconds >= 120 && restSeconds % 60 === 0) return `Rest ${restSeconds / 60} min`;
  return `Rest ${restSeconds} s`;
}

/** The phone list's second line: "3 × 12 · rest 90 s". */
export function doseLine(
  exercise: Pick<MemberPlanExercise, 'sets' | 'reps' | 'restSeconds'>,
): string {
  const rest = restLabel(exercise.restSeconds);
  return rest === 'No rest'
    ? dose(exercise)
    : `${dose(exercise)} · ${rest.replace('Rest', 'rest')}`;
}

export function aboutMinutes(minutes: number): string {
  return `About ${minutes} min`;
}

export function exerciseCount(n: number): string {
  return `${n} ${n === 1 ? 'exercise' : 'exercises'}`;
}

/** The green bar after Adjust: what was asked, and what the day became. */
export function adjustedSummary(
  request: string,
  day: Pick<MemberPlanDay, 'title' | 'minutes' | 'exercises'>,
): string {
  return `${request} — now “${day.title}”: ${exerciseCount(day.exercises.length)}, about ${day.minutes} min.`;
}

/** "DAY 1 · MONDAY" */
export function dayKicker(index: number, weekday: number): string {
  return `DAY ${index + 1} · ${WEEKDAY_LONG[weekday]?.toUpperCase() ?? ''}`;
}

/** "Sep 28" in the gym's zone. */
export function shortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: GYM_TIMEZONE,
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso));
}

/** "Build muscle · Beginner · 45 min sessions" */
export function planMeta(plan: MemberWorkoutPlanView): string {
  const { goal, experience, sessionMinutes } = plan.intake;
  return `${GOAL_LABEL[goal].title} · ${LEVEL_LABEL[experience].short} · ${sessionMinutes} min sessions`;
}

export function savedLabel(plan: MemberWorkoutPlanView): string {
  return `Saved ${shortDate(plan.updatedAt)}`;
}

export interface DayDot {
  weekday: number;
  letter: string;
  name: string;
  on: boolean;
}

/** Monday-first M T W T F S S, lit on the plan's training days. */
export function dayDots(weekdays: readonly number[]): DayDot[] {
  return WEEK_ORDER.map((weekday) => ({
    weekday,
    letter: (WEEKDAY_SHORT[weekday] ?? '?').charAt(0),
    name: WEEKDAY_LONG[weekday] ?? '',
    on: weekdays.includes(weekday),
  }));
}

export interface PlanChip {
  label: string;
  tone: 'neutral' | 'warn';
}

export function planChips(intake: WorkoutIntakeSummary): PlanChip[] {
  const chips: PlanChip[] = [
    { label: GOAL_LABEL[intake.goal].title, tone: 'neutral' },
    { label: LEVEL_LABEL[intake.experience].title, tone: 'neutral' },
    { label: weekdayList(intake.weekdays), tone: 'neutral' },
    { label: `${intake.sessionMinutes} min · ${TIME_LABEL[intake.timeOfDay]}`, tone: 'neutral' },
  ];
  if (intake.easyOn.length > 0) {
    chips.push({ label: `Go easy on ${easyOnPhrase(intake.easyOn)}`, tone: 'warn' });
  }
  if (intake.healthFlag) chips.push({ label: 'Kept gentle', tone: 'warn' });
  return chips;
}

const CHECK_LINE = 'check with a coach or the front desk if anything feels off.';

export function writtenLine(
  plan: Pick<MemberWorkoutPlanView, 'source' | 'createdAt' | 'updatedAt'>,
): string {
  const written = `Written by AI on ${shortDate(plan.createdAt)}`;
  return plan.source === 'EDITED'
    ? `${written}, edited by you on ${shortDate(plan.updatedAt)} — ${CHECK_LINE}`
    : `${written} — ${CHECK_LINE}`;
}

export interface WeekRow {
  weekday: number;
  day: string;
  what: string;
  kind: 'train' | 'class' | 'rest';
}

/**
 * The rail's YOUR WEEK list. `classes` maps a weekday to its booked-class
 * caption (from `bookedClassesByWeekday`); a planned session wins the row.
 */
export function weekRows(plan: MemberPlanBody, classes: Record<number, string>): WeekRow[] {
  return WEEK_ORDER.map((weekday) => {
    const day = plan.days.find((d) => d.weekday === weekday);
    const label = WEEKDAY_SHORT[weekday] ?? '';
    if (day !== undefined) return { weekday, day: label, what: day.title, kind: 'train' };
    const klass = classes[weekday];
    if (klass !== undefined) return { weekday, day: label, what: klass, kind: 'class' };
    return { weekday, day: label, what: 'Rest', kind: 'rest' };
  });
}
