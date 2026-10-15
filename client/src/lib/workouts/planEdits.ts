import type {
  MemberPlanBody,
  MemberPlanDay,
  MemberPlanExercise,
  SwapAlternative,
} from '@got/shared';

/**
 * Swap and Adjust results applied to a plan body, immutably, with one level
 * of undo. The plan on screen is `history.current`; the server is only told
 * on Keep (`PUT …/body`), so Undo is a local revert and costs nothing.
 */

export function applySwap(
  plan: MemberPlanBody,
  weekday: number,
  index: number,
  alternative: SwapAlternative,
): MemberPlanBody {
  const dayIndex = plan.days.findIndex((d) => d.weekday === weekday);
  const day = plan.days[dayIndex];
  if (day === undefined || index < 0 || index >= day.exercises.length) return plan;

  // `why` is the alternative's sales pitch, not part of an exercise.
  const { why: _why, ...exercise } = alternative;
  void _why;
  const replacement: MemberPlanExercise = exercise;
  const exercises = day.exercises.map((e, i) => (i === index ? replacement : e));
  const days = plan.days.map((d, i) => (i === dayIndex ? { ...day, exercises } : d));
  return { ...plan, days };
}

export function applyAdjust(plan: MemberPlanBody, day: MemberPlanDay): MemberPlanBody {
  const dayIndex = plan.days.findIndex((d) => d.weekday === day.weekday);
  if (dayIndex === -1) return plan;
  return { ...plan, days: plan.days.map((d, i) => (i === dayIndex ? day : d)) };
}

export type PendingEdit =
  | { kind: 'swap'; weekday: number; index: number; from: string; to: string }
  | { kind: 'adjust'; weekday: number; summary: string };

export interface EditHistory {
  current: MemberPlanBody;
  /** The body before the pending action; kept until the next action or Keep. */
  previous: MemberPlanBody | null;
  pending: PendingEdit | null;
}

export function freshHistory(plan: MemberPlanBody): EditHistory {
  return { current: plan, previous: null, pending: null };
}

export function beginEdit(
  history: EditHistory,
  next: MemberPlanBody,
  pending: PendingEdit,
): EditHistory {
  return { current: next, previous: history.current, pending };
}

export function undoEdit(history: EditHistory): EditHistory {
  if (history.previous === null) return history;
  return { current: history.previous, previous: null, pending: null };
}

export function commitEdit(history: EditHistory): EditHistory {
  return { current: history.current, previous: null, pending: null };
}
