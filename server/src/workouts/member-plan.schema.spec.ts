import {
  WORKOUT_LIMITS,
  exerciseSlug,
  parseMemberPlan,
  parseWorkoutIntake,
  type MemberPlanBody,
  type WorkoutIntake,
} from '@got/shared';

/**
 * The member plan schema and the intake rules — the two checks the wizard,
 * the DTO, the draft job and the hand-edit save all share (feat/member-workouts).
 */

const exercise = (over: Record<string, unknown> = {}) => ({
  name: 'Goblet squat',
  muscles: 'Legs · glutes',
  sets: 3,
  reps: '10-12',
  restSeconds: 90,
  ...over,
});

const day = (over: Record<string, unknown> = {}) => ({
  weekday: 1,
  title: 'Full body A',
  focus: 'Legs, push, pull',
  minutes: 45,
  warmUp: '5 min easy bike',
  coolDown: '3 min walk and stretches',
  exercises: [exercise()],
  ...over,
});

const plan = (over: Record<string, unknown> = {}) => ({
  summary: 'Three full-body days.',
  days: [day(), day({ weekday: 3, title: 'Full body B' })],
  guidance: [
    { title: 'Sleep', body: '7-9 hours.' },
    { title: 'Water', body: 'Drink before and after.' },
  ],
  ...over,
});

describe('parseMemberPlan', () => {
  it('accepts a well-formed plan and normalises it', () => {
    const result = parseMemberPlan(
      plan({
        summary: '  Three days.  ',
        days: [day({ exercises: [exercise({ reps: 12, notes: '  ' })] })],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value: MemberPlanBody = result.value;
    expect(value.summary).toBe('Three days.');
    expect(value.days[0].exercises[0].reps).toBe('12');
    expect('notes' in value.days[0].exercises[0]).toBe(false);
  });

  it('rejects a repeated weekday', () => {
    const result = parseMemberPlan(plan({ days: [day(), day()] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('days: weekday 1 appears more than once.');
  });

  it('rejects unknown fields at every level', () => {
    const result = parseMemberPlan(
      plan({ extra: 1, days: [day({ nope: true, exercises: [exercise({ video: 'x' })] })] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'Unexpected field "extra".',
        'days[0]: unexpected field "nope".',
        'days[0].exercises[0]: unexpected field "video".',
      ]),
    );
  });

  it('reports every error at once and never echoes a value', () => {
    const result = parseMemberPlan(
      plan({
        summary: '',
        days: [
          day({ weekday: 7, minutes: 5, exercises: [exercise({ sets: 0, restSeconds: 999 })] }),
        ],
        guidance: [{ title: 'Only one', body: 'tip' }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(5);
    for (const message of result.errors) expect(message).not.toContain('999');
  });

  it('bounds the day count, the exercise count and the guidance count', () => {
    const many = Array.from({ length: WORKOUT_LIMITS.daysMax + 1 }, (_, i) =>
      day({ weekday: i % 7 }),
    );
    expect(parseMemberPlan(plan({ days: many })).ok).toBe(false);
    const crowded = day({
      exercises: Array.from({ length: WORKOUT_LIMITS.exercisesMax + 1 }, () => exercise()),
    });
    expect(parseMemberPlan(plan({ days: [crowded] })).ok).toBe(false);
    expect(parseMemberPlan(plan({ guidance: [] })).ok).toBe(false);
  });

  it('is not fooled by a script-shaped string, which is just a long string', () => {
    const result = parseMemberPlan(plan({ days: [day({ title: '<script>alert(1)</script>' })] }));
    // Text is text; rendering never uses innerHTML. Length is the only rule.
    expect(result.ok).toBe(true);
  });

  it('refuses non-objects', () => {
    expect(parseMemberPlan(null).ok).toBe(false);
    expect(parseMemberPlan([]).ok).toBe(false);
    expect(parseMemberPlan('plan').ok).toBe(false);
  });
});

const intake = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  goal: 'MUSCLE',
  experience: 'NEW',
  weekdays: [6, 1, 3],
  sessionMinutes: 45,
  timeOfDay: 'EVENING',
  healthFlag: false,
  easyOn: ['KNEES'],
  use: { measurements: true, attendance: true, bookings: true },
  consent: true,
  ...over,
});

describe('parseWorkoutIntake', () => {
  it('accepts a full intake and sorts the weekdays', () => {
    const result = parseWorkoutIntake(intake({ goalNotes: ' 10 push-ups by December ' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value: WorkoutIntake = result.value;
    expect(value.weekdays).toEqual([1, 3, 6]);
    expect(value.goalNotes).toBe('10 push-ups by December');
    expect(value.consent).toBe(true);
  });

  it('drops blank notes rather than storing ""', () => {
    const result = parseWorkoutIntake(intake({ goalNotes: '   ' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('goalNotes' in result.value).toBe(false);
  });

  it('requires consent to be literally true', () => {
    for (const consent of [false, 'true', 1, undefined]) {
      const result = parseWorkoutIntake(intake({ consent }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors).toContain('consent must be true.');
    }
  });

  it('rejects repeated or out-of-range weekdays, and bad session lengths', () => {
    expect(parseWorkoutIntake(intake({ weekdays: [1, 1] })).ok).toBe(false);
    expect(parseWorkoutIntake(intake({ weekdays: [7] })).ok).toBe(false);
    expect(parseWorkoutIntake(intake({ weekdays: [] })).ok).toBe(false);
    expect(parseWorkoutIntake(intake({ sessionMinutes: 50 })).ok).toBe(false);
  });

  it('rejects unknown enum values and unknown fields', () => {
    expect(parseWorkoutIntake(intake({ goal: 'ABS' })).ok).toBe(false);
    expect(parseWorkoutIntake(intake({ easyOn: ['KNEES', 'ELBOWS'] })).ok).toBe(false);
    expect(parseWorkoutIntake(intake({ parq: [true] })).ok).toBe(false);
    expect(parseWorkoutIntake(intake({ use: { measurements: true } })).ok).toBe(false);
  });
});

describe('exerciseSlug', () => {
  it('lowercases, strips accents and punctuation, and bounds the length', () => {
    expect(exerciseSlug('Goblet Squat')).toBe('goblet-squat');
    expect(exerciseSlug('  Dumbbell R.D.L. (heavy) ')).toBe('dumbbell-r-d-l-heavy');
    expect(exerciseSlug('Élévation latérale')).toBe('elevation-laterale');
    expect(exerciseSlug('x'.repeat(200))).toHaveLength(80);
    expect(exerciseSlug('!!!')).toBe('');
  });
});
