import { describe, expect, it } from 'vitest';
import { WORKOUT_GOALS } from '@got/shared';
import { BODY_COPY, accountBodyLine, bodySummary, goalChoice, keepSuitableGoal } from './body';
import { initialIntake } from './intake';

/**
 * The planner's account-numbers line and BMI goal filter (owner, 2026-10-23).
 */
describe('the account body line', () => {
  it('shows height, weight and BMI to one decimal', () => {
    expect(accountBodyLine({ heightCm: 170, weightKg: 55 })).toBe(
      'From your account: 170 cm · 55 kg · BMI 19.0',
    );
    expect(accountBodyLine({ heightCm: 175.5, weightKg: 72.4 })).toBe(
      'From your account: 175.5 cm · 72.4 kg · BMI 23.5',
    );
  });

  it('asks for the numbers when either is missing', () => {
    expect(accountBodyLine({ heightCm: null, weightKg: 55 })).toBe(BODY_COPY.missing);
    expect(BODY_COPY.missing).toBe(
      'Add your height and weight in My Account so the planner can fit the goals to you.',
    );
  });
});

describe('the rail Body row', () => {
  it('reads height and weight, or Not set', () => {
    expect(bodySummary({ heightCm: 170, weightKg: 55 })).toBe('170 cm · 55 kg');
    expect(bodySummary({ heightCm: 170, weightKg: null })).toBe('Not set');
    expect(bodySummary(null)).toBe('Not set');
  });
});

describe('the goal filter', () => {
  it('hides Lose fat under BMI 18.5 and says why', () => {
    const choice = goalChoice({ heightCm: 180, weightKg: 55 });
    expect(choice.goals).not.toContain('FAT_LOSS');
    expect(choice.goals).toHaveLength(WORKOUT_GOALS.length - 1);
    expect(choice.hiddenNote).toBe('Lose fat is hidden because your BMI is under 18.5.');
  });

  it('offers every goal with no note otherwise, or when the numbers are unknown', () => {
    expect(goalChoice({ heightCm: 170, weightKg: 70 })).toEqual({
      goals: [...WORKOUT_GOALS],
      hiddenNote: null,
    });
    expect(goalChoice({ heightCm: null, weightKg: null }).goals).toEqual([...WORKOUT_GOALS]);
    expect(goalChoice(null).goals).toEqual([...WORKOUT_GOALS]);
  });

  it('drops a prefilled goal that is no longer offered', () => {
    const state = { ...initialIntake(), goal: 'FAT_LOSS' as const };
    expect(keepSuitableGoal(state, { heightCm: 180, weightKg: 55 }).goal).toBeNull();
    expect(keepSuitableGoal(state, { heightCm: 170, weightKg: 70 }).goal).toBe('FAT_LOSS');
    const muscle = { ...initialIntake(), goal: 'MUSCLE' as const };
    expect(keepSuitableGoal(muscle, { heightCm: 180, weightKg: 55 })).toBe(muscle);
  });
});
