/**
 * Which planner goals suit the member's body (owner, 2026-10-23).
 *
 * BMI = weightKg / (heightCm / 100)², from the member's ACCOUNT values
 * (`User.heightCm`, `User.weightKg`). Under the WHO underweight line the
 * "Lose fat" goal is not offered: the wizard hides it and the API refuses it.
 * Every other goal is always offered, and a missing height or weight offers
 * everything. One copy, two runtimes.
 */

import { WORKOUT_GOALS, type WorkoutGoal } from './workouts.types';

/** WHO: a BMI below this is underweight. */
export const BMI_UNDERWEIGHT_BELOW = 18.5;

/** Goals withheld from an underweight member. */
export const UNDERWEIGHT_HIDDEN_GOALS: readonly WorkoutGoal[] = ['FAT_LOSS'];

export const GOAL_NOT_SUITABLE_MESSAGE = "Lose fat isn't offered at your current BMI.";

/** BMI, or null when either number is missing or not positive. */
export function bmiOf(
  heightCm: number | null | undefined,
  weightKg: number | null | undefined,
): number | null {
  if (heightCm == null || weightKg == null) return null;
  if (!(heightCm > 0) || !(weightKg > 0)) return null;
  const metres = heightCm / 100;
  return weightKg / (metres * metres);
}

export function isGoalSuitable(goal: WorkoutGoal, bmi: number | null): boolean {
  if (bmi === null || bmi >= BMI_UNDERWEIGHT_BELOW) return true;
  return !UNDERWEIGHT_HIDDEN_GOALS.includes(goal);
}

/** The goals to offer, in the wizard's order. */
export function suitableGoals(bmi: number | null): WorkoutGoal[] {
  return WORKOUT_GOALS.filter((goal) => isGoalSuitable(goal, bmi));
}
