import {
  BMI_UNDERWEIGHT_BELOW,
  WORKOUT_GOALS,
  bmiOf,
  isGoalSuitable,
  suitableGoals,
  type WorkoutGoal,
} from '@got/shared';
import type { IntakeState } from './intake';

/**
 * The planner's view of the member's ACCOUNT height and weight (owner,
 * 2026-10-23): a reminder line above the goals, the rail's Body row, and the
 * BMI goal filter. The rule itself lives in @got/shared so the API refuses
 * exactly what this hides.
 */

/** The two account numbers, as `GET /me/profile` returns them. */
export interface AccountBody {
  heightCm: number | null;
  weightKg: number | null;
}

export const BODY_COPY = {
  missing: 'Add your height and weight in My Account so the planner can fit the goals to you.',
  editLink: 'Edit in My Account',
  fatLossHidden: `Lose fat is hidden because your BMI is under ${BMI_UNDERWEIGHT_BELOW}.`,
  notSet: 'Not set',
} as const;

/** 170 → "170", 72.4 → "72.4", 72.45 → "72.5". */
function num(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function bmiFor(body: AccountBody | null): number | null {
  return body === null ? null : bmiOf(body.heightCm, body.weightKg);
}

/** "170 cm · 55 kg", or "Not set" when either is missing. */
export function bodySummary(body: AccountBody | null): string {
  if (body === null || body.heightCm === null || body.weightKg === null) return BODY_COPY.notSet;
  return `${num(body.heightCm)} cm · ${num(body.weightKg)} kg`;
}

/** The line above the goal cards. */
export function accountBodyLine(body: AccountBody): string {
  const bmi = bmiFor(body);
  if (bmi === null) return BODY_COPY.missing;
  return `From your account: ${bodySummary(body)} · BMI ${bmi.toFixed(1)}`;
}

/** The goals to offer, and the muted note when one is hidden. */
export function goalChoice(body: AccountBody | null): {
  goals: WorkoutGoal[];
  hiddenNote: string | null;
} {
  const goals = suitableGoals(bmiFor(body));
  return {
    goals,
    hiddenNote: goals.length < WORKOUT_GOALS.length ? BODY_COPY.fatLossHidden : null,
  };
}

/** A prefilled goal (Regenerate, last intake) the member can no longer pick is cleared. */
export function keepSuitableGoal(state: IntakeState, body: AccountBody | null): IntakeState {
  if (state.goal === null || isGoalSuitable(state.goal, bmiFor(body))) return state;
  return { ...state, goal: null };
}
