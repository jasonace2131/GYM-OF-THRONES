import { WORKOUT_PLAN_LIMITS, parseWorkoutPlan, type WorkoutPlanBody } from '@got/shared';

/**
 * The workout-plan schema, which guards BOTH doors into WorkoutPlan.body: the
 * model's reply to "suggest a plan", and the coach's own save. One copy in
 * @got/shared, so the coach's editor refuses exactly what the server refuses.
 */
describe('parseWorkoutPlan', () => {
  const valid = (): WorkoutPlanBody => ({
    summary: 'Three full-body days to build a base.',
    days: [
      {
        day: 'Monday',
        focus: 'Lower body',
        exercises: [
          { name: 'Goblet squat', sets: 3, reps: '8-10' },
          { name: 'Romanian deadlift', sets: 3, reps: '10', notes: 'Light, slow lowering' },
        ],
      },
    ],
  });

  const errorsOf = (input: unknown): string[] => {
    const result = parseWorkoutPlan(input);
    if (result.ok) throw new Error('expected the plan to be refused');
    return result.errors;
  };

  it('accepts a well-formed plan and returns it unchanged', () => {
    expect(parseWorkoutPlan(valid())).toEqual({ ok: true, plan: valid() });
  });

  it('trims every string, and drops blank notes rather than storing ""', () => {
    const input = valid();
    input.summary = '  Base block  ';
    input.days[0].day = ' Monday ';
    input.days[0].exercises[0] = { name: ' Squat ', sets: 3, reps: ' 8 ', notes: '   ' };

    const result = parseWorkoutPlan(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.summary).toBe('Base block');
    expect(result.plan.days[0].day).toBe('Monday');
    expect(result.plan.days[0].exercises[0]).toEqual({ name: 'Squat', sets: 3, reps: '8' });
  });

  it('accepts whole-number reps and stores them as text', () => {
    const input = valid() as unknown as { days: { exercises: { reps: unknown }[] }[] };
    input.days[0].exercises[0].reps = 12;

    const result = parseWorkoutPlan(input);

    expect(result.ok && result.plan.days[0].exercises[0].reps).toBe('12');
  });

  it.each([null, undefined, 'plan', 42, [], [valid()]])('refuses %p as a plan', (input) => {
    expect(errorsOf(input)).toEqual(['The plan must be an object with a summary and days.']);
  });

  it('refuses a field the schema does not name, at every level', () => {
    const top = { ...valid(), extra: true };
    expect(errorsOf(top)).toContain('Unexpected field "extra".');

    const day = valid() as unknown as { days: Record<string, unknown>[] };
    day.days[0]['warmup'] = 'jog';
    expect(errorsOf(day)).toContain('days[0]: unexpected field "warmup".');

    const exercise = valid() as unknown as { days: { exercises: Record<string, unknown>[] }[] };
    exercise.days[0].exercises[0]['weightKg'] = 40;
    expect(errorsOf(exercise)).toContain('days[0].exercises[0]: unexpected field "weightKg".');
  });

  it('refuses a missing or blank summary, and one over the limit', () => {
    expect(errorsOf({ days: valid().days })).toContain(
      `summary must be 1-${WORKOUT_PLAN_LIMITS.summaryMax} characters.`,
    );
    expect(errorsOf({ ...valid(), summary: '   ' })).toContain(
      `summary must be 1-${WORKOUT_PLAN_LIMITS.summaryMax} characters.`,
    );
    expect(
      errorsOf({ ...valid(), summary: 'x'.repeat(WORKOUT_PLAN_LIMITS.summaryMax + 1) }),
    ).toContain(`summary must be 1-${WORKOUT_PLAN_LIMITS.summaryMax} characters.`);
  });

  it('needs 1 to 7 days', () => {
    expect(errorsOf({ ...valid(), days: [] })).toContain(
      `days must hold 1-${WORKOUT_PLAN_LIMITS.daysMax} days.`,
    );
    const eight = Array.from({ length: 8 }, () => valid().days[0]);
    expect(errorsOf({ ...valid(), days: eight })).toContain(
      `days must hold 1-${WORKOUT_PLAN_LIMITS.daysMax} days.`,
    );
    expect(errorsOf({ ...valid(), days: 'Monday' })).toContain(
      `days must hold 1-${WORKOUT_PLAN_LIMITS.daysMax} days.`,
    );
  });

  it('names the day that is wrong', () => {
    const input = valid();
    input.days.push({ day: '', focus: 'Upper', exercises: [] });

    const errors = errorsOf(input);

    expect(errors).toContain(
      `days[1].day must be 1-${WORKOUT_PLAN_LIMITS.dayLabelMax} characters.`,
    );
    expect(errors).toContain(
      `days[1].exercises must hold 1-${WORKOUT_PLAN_LIMITS.exercisesMax} exercises.`,
    );
  });

  it('needs whole-number sets from 1 to 10', () => {
    for (const sets of [0, 11, 2.5, '3', null]) {
      const input = valid() as unknown as { days: { exercises: { sets: unknown }[] }[] };
      input.days[0].exercises[0].sets = sets;
      expect(errorsOf(input)).toContain(
        `days[0].exercises[0].sets must be a whole number from 1 to ${WORKOUT_PLAN_LIMITS.setsMax}.`,
      );
    }
  });

  it('needs reps as short text, and bounds names and notes', () => {
    const input = valid() as unknown as {
      days: { exercises: { name: unknown; reps: unknown; notes?: unknown }[] }[];
    };
    input.days[0].exercises[0].reps = '';
    input.days[0].exercises[0].name = 'x'.repeat(WORKOUT_PLAN_LIMITS.exerciseNameMax + 1);
    input.days[0].exercises[1].notes = 'x'.repeat(WORKOUT_PLAN_LIMITS.notesMax + 1);

    const errors = errorsOf(input);

    expect(errors).toContain(
      `days[0].exercises[0].reps must be 1-${WORKOUT_PLAN_LIMITS.repsMax} characters.`,
    );
    expect(errors).toContain(
      `days[0].exercises[0].name must be 1-${WORKOUT_PLAN_LIMITS.exerciseNameMax} characters.`,
    );
    expect(errors).toContain(
      `days[0].exercises[1].notes must be at most ${WORKOUT_PLAN_LIMITS.notesMax} characters.`,
    );
  });

  it('refuses more than twelve exercises in a day', () => {
    const input = valid();
    input.days[0].exercises = Array.from({ length: 13 }, () => ({
      name: 'Plank',
      sets: 3,
      reps: '30s',
    }));
    expect(errorsOf(input)).toContain(
      `days[0].exercises must hold 1-${WORKOUT_PLAN_LIMITS.exercisesMax} exercises.`,
    );
  });

  it('does not echo the rejected values back in its messages', () => {
    const input = valid() as unknown as { days: { exercises: { name: unknown }[] }[] };
    input.days[0].exercises[0].name = 42;
    expect(errorsOf(input).join(' ')).not.toContain('42');
  });
});
