import {
  BMI_UNDERWEIGHT_BELOW,
  bmiOf,
  isGoalSuitable,
  suitableGoals,
  WORKOUT_GOALS,
} from '@got/shared';

/**
 * The planner's BMI rule (owner, 2026-10-23): BMI from the ACCOUNT height and
 * weight; under 18.5 (WHO underweight) the "Lose fat" goal is not offered.
 * Missing numbers offer every goal. One copy, used by the wizard and the API.
 */
describe('goal suitability by BMI', () => {
  it('computes BMI as kg / m², and null when either number is missing', () => {
    expect(bmiOf(170, 55)).toBeCloseTo(19.03, 2);
    expect(bmiOf(null, 55)).toBeNull();
    expect(bmiOf(170, null)).toBeNull();
    expect(bmiOf(0, 55)).toBeNull();
  });

  it('uses the WHO underweight threshold', () => {
    expect(BMI_UNDERWEIGHT_BELOW).toBe(18.5);
  });

  it('hides Lose fat under 18.5 and keeps every other goal', () => {
    const bmi = bmiOf(180, 55); // 16.98
    expect(isGoalSuitable('FAT_LOSS', bmi)).toBe(false);
    expect(suitableGoals(bmi)).toEqual(WORKOUT_GOALS.filter((g) => g !== 'FAT_LOSS'));
  });

  it('offers Lose fat at exactly 18.5 and above', () => {
    expect(isGoalSuitable('FAT_LOSS', 18.5)).toBe(true);
    expect(isGoalSuitable('FAT_LOSS', 24)).toBe(true);
  });

  it('offers every goal when BMI is unknown', () => {
    expect(suitableGoals(null)).toEqual([...WORKOUT_GOALS]);
  });
});
