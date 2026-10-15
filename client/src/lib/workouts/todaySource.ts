import type {
  CoachPlanInWorkouts,
  MemberWorkoutPlanView,
  StartSessionBody,
  WorkoutSessionSummary,
  WorkoutsHome,
} from '@got/shared';
import { coachDayTitle } from './coachPlan';

/**
 * Which plan drives Today (spec §1.1): the member's ACTIVE AI plan, else the
 * coach's plan. "Use this plan" on the coach card clears the AI plans'
 * active flag, which is how a member hands Today back to their coach.
 */

export type TodaySource =
  | { kind: 'member'; plan: MemberWorkoutPlanView }
  | { kind: 'coach'; plan: CoachPlanInWorkouts }
  | { kind: 'none' };

export function todaySource(home: Pick<WorkoutsHome, 'plans' | 'coachPlan'>): TodaySource {
  const active = home.plans.find((p) => p.isActive);
  if (active !== undefined) return { kind: 'member', plan: active };
  if (home.coachPlan !== null) return { kind: 'coach', plan: home.coachPlan };
  return { kind: 'none' };
}

export type CoachToday =
  | { kind: 'train'; dayIndex: number }
  | { kind: 'rest'; next: { dayIndex: number; weekday: number } | null }
  /** No day names a weekday: Today lists them all — "Which day are you doing?". */
  | { kind: 'pick' };

/**
 * Today from the coach's labels. Only a label that IS a weekday counts
 * (`coachDayWeekdays`), so an unlabelled day is never guessed onto Today;
 * it can still be started from the coach's plan page.
 */
export function coachToday(plan: CoachPlanInWorkouts, weekday: number): CoachToday {
  if (plan.weekdays.every((w) => w === null)) return { kind: 'pick' };
  const index = plan.weekdays.indexOf(weekday);
  if (index !== -1) return { kind: 'train', dayIndex: index };
  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = (weekday + offset) % 7;
    const next = plan.weekdays.indexOf(candidate);
    if (next !== -1) return { kind: 'rest', next: { dayIndex: next, weekday: candidate } };
  }
  return { kind: 'rest', next: null };
}

export interface PlannedDay {
  weekday: number;
  title: string;
}

/** The week strip's planned days, from whichever plan drives Today. */
export function plannedWeek(source: TodaySource): PlannedDay[] {
  if (source.kind === 'member') {
    return source.plan.plan.days.map((d) => ({ weekday: d.weekday, title: d.title }));
  }
  if (source.kind === 'coach') {
    const out: PlannedDay[] = [];
    source.plan.weekdays.forEach((weekday, i) => {
      const day = source.plan.plan.days[i];
      if (weekday !== null && day !== undefined) out.push({ weekday, title: coachDayTitle(day) });
    });
    return out;
  }
  return [];
}

/** The newest workout finished on that gym day, if any. */
export function finishedOn(
  recent: readonly WorkoutSessionSummary[],
  day: string,
): WorkoutSessionSummary | null {
  return recent.find((s) => s.businessDate === day) ?? null;
}

/** Gym days with a finished workout — the week strip ticks them. */
export function workoutDays(recent: readonly WorkoutSessionSummary[]): string[] {
  return recent.map((s) => s.businessDate);
}

/** One startable day's identity: its inline "workout already open" choice sits beside it. */
export function startKey(body: StartSessionBody): string {
  return body.source === 'MEMBER_PLAN' ? `m:${body.planId}:${body.weekday}` : `c:${body.dayIndex}`;
}
