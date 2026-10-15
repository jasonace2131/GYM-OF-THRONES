import {
  WORKOUT_PLAN_LIMITS,
  sessionExercisesFromCoachDay,
  weekdayFromLabel,
  type CoachPlanInWorkouts,
  type SessionExercise,
  type StartSessionBody,
  type WorkoutDay,
} from '@got/shared';
import { WEEKDAY_LONG, weekdayList } from './labels';
import { exerciseCount, shortDate } from './planView';

/**
 * The coach's plan as the member's Workouts page shows it (spec §1.1, §5):
 * read-only, first in "My workout plans", and startable day by day.
 *
 * A coach's plan has no name and no weekdays of its own — only the coach's
 * day labels, which `CoachPlanInWorkouts.weekdays` has already read for us.
 */

export const COACH_PLAN_HREF = '/portal/workouts/coach';

export function coachDayHref(index: number): string {
  return `${COACH_PLAN_HREF}#coach-day-${index}`;
}

type WithCoach = Pick<CoachPlanInWorkouts, 'coach'>;

/** "Coach Ana", or "your coach" when that account has since been removed. */
export function coachName(plan: WithCoach): string {
  return plan.coach === null ? 'your coach' : `Coach ${plan.coach.firstName}`;
}

export function coachPlanTitle(plan: WithCoach): string {
  return plan.coach === null ? "Your coach's plan" : `Coach ${plan.coach.firstName}'s plan`;
}

/** The badge text; the Tag renders it in capitals: "FROM COACH ANA". */
export function coachBadge(plan: WithCoach): string {
  return plan.coach === null ? 'From your coach' : `From coach ${plan.coach.firstName}`;
}

/** "3 days · Mon · Wed · Fri · updated by your coach Sep 27". */
export function coachPlanMeta(plan: CoachPlanInWorkouts): string {
  const n = plan.plan.days.length;
  const parts = [`${n} ${n === 1 ? 'day' : 'days'}`];
  const named = plan.weekdays.filter((w): w is number => w !== null);
  if (named.length > 0) parts.push(weekdayList(named));
  parts.push(`updated by your coach ${shortDate(plan.updatedAt)}`);
  return parts.join(' · ');
}

/**
 * A coach day is titled by its FOCUS — "Lower body" — because that is what
 * the server names the workout started from it (`dayTitle`, clipped to 40
 * there), so Today, the plan page, the session and history all agree. The
 * coach's label goes in the kicker.
 */
export function coachDayTitle(day: WorkoutDay): string {
  return day.focus;
}

/** "DAY 1 · MONDAY", "DAY 1 · UPPER A", or just "DAY 1" when the label says no more. */
function coachDayKicker(day: WorkoutDay, index: number, weekday: number | null): string {
  const number = `DAY ${index + 1}`;
  if (weekday !== null) return `${number} · ${(WEEKDAY_LONG[weekday] ?? '').toUpperCase()}`;
  const label = day.day.trim();
  if (label === '' || label.toLowerCase() === `day ${index + 1}`) return number;
  const named = weekdayFromLabel(label);
  return `${number} · ${(named === null ? label : (WEEKDAY_LONG[named] ?? label)).toUpperCase()}`;
}

export interface CoachDayView {
  index: number;
  weekday: number | null;
  kicker: string;
  title: string;
  count: string;
  /** As the session will snapshot them — rest defaults to 90 s. */
  exercises: SessionExercise[];
  start: StartSessionBody;
  anchor: string;
}

export function coachDays(plan: CoachPlanInWorkouts): CoachDayView[] {
  return plan.plan.days.slice(0, WORKOUT_PLAN_LIMITS.daysMax).map((day, index) => {
    const weekday = plan.weekdays[index] ?? null;
    return {
      index,
      weekday,
      kicker: coachDayKicker(day, index, weekday),
      title: coachDayTitle(day),
      count: exerciseCount(day.exercises.length),
      exercises: sessionExercisesFromCoachDay(day),
      start: { source: 'COACH_PLAN', dayIndex: index },
      anchor: `coach-day-${index}`,
    };
  });
}
