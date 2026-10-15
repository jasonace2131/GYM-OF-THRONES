import {
  DEFAULT_REST_SECONDS,
  SESSION_IDLE_CLOSE_MS,
  coachDayWeekdays,
  durationMinutes,
  finishInstant,
  parseLogSetBody,
  sessionExercisesFromCoachDay,
  sessionExercisesFromMemberDay,
  sessionStats,
  targetReps,
  weekdayFromLabel,
  type SessionExercise,
  type WorkoutPlanBody,
} from '@got/shared';

/**
 * The shared rules of workout sessions (feat/workout-sessions): snapshots,
 * the coach's day labels, logged-set validation and the stats both the phone
 * and history show.
 */

describe('weekdayFromLabel', () => {
  it('reads full and short English names, case-insensitively, trailing dot allowed', () => {
    expect(weekdayFromLabel('Monday')).toBe(1);
    expect(weekdayFromLabel('  mon. ')).toBe(1);
    expect(weekdayFromLabel('THURS')).toBe(4);
    expect(weekdayFromLabel('Sun')).toBe(0);
    expect(weekdayFromLabel('saturday')).toBe(6);
  });

  it('reads Filipino names', () => {
    expect(weekdayFromLabel('Lunes')).toBe(1);
    expect(weekdayFromLabel('Miyerkules')).toBe(3);
    expect(weekdayFromLabel('Biyernes')).toBe(5);
    expect(weekdayFromLabel('Linggo')).toBe(0);
  });

  it('refuses anything that is not exactly a weekday', () => {
    expect(weekdayFromLabel('Day 1')).toBeNull();
    expect(weekdayFromLabel('Monday or Tuesday')).toBeNull();
    expect(weekdayFromLabel('Leg day')).toBeNull();
    expect(weekdayFromLabel('')).toBeNull();
  });
});

const coachPlan = (labels: string[]): WorkoutPlanBody => ({
  summary: 'Plan',
  days: labels.map((day) => ({
    day,
    focus: 'Full body',
    exercises: [{ name: 'Leg press', sets: 3, reps: '12' }],
  })),
});

describe('coachDayWeekdays', () => {
  it('maps each day and leaves unmappable ones null', () => {
    expect(coachDayWeekdays(coachPlan(['Monday', 'Day 2', 'Fri']))).toEqual([1, null, 5]);
  });

  it('keeps only the first day of a repeated weekday', () => {
    expect(coachDayWeekdays(coachPlan(['Monday', 'mon', 'Wednesday']))).toEqual([1, null, 3]);
  });
});

describe('snapshots', () => {
  it('copies a member day exercise for exercise', () => {
    const out = sessionExercisesFromMemberDay({
      weekday: 1,
      title: 'Full body A',
      focus: 'All',
      minutes: 45,
      warmUp: 'Bike',
      coolDown: 'Walk',
      exercises: [
        {
          name: 'Goblet squat',
          muscles: 'Legs',
          sets: 3,
          reps: '10-12',
          restSeconds: 90,
          notes: 'Chest up',
        },
        { name: 'Plank', muscles: 'Core', sets: 3, reps: '30 s', restSeconds: 45 },
      ],
    });
    expect(out).toEqual([
      {
        name: 'Goblet squat',
        muscles: 'Legs',
        sets: 3,
        reps: '10-12',
        restSeconds: 90,
        notes: 'Chest up',
      },
      { name: 'Plank', muscles: 'Core', sets: 3, reps: '30 s', restSeconds: 45 },
    ]);
  });

  it('gives a coach day the default rest and no muscles', () => {
    const [day] = coachPlan(['Monday']).days;
    expect(sessionExercisesFromCoachDay(day)).toEqual([
      { name: 'Leg press', muscles: null, sets: 3, reps: '12', restSeconds: DEFAULT_REST_SECONDS },
    ]);
  });
});

describe('targetReps', () => {
  it('takes the first whole number, or null', () => {
    expect(targetReps('8-12')).toBe(8);
    expect(targetReps('30 s')).toBe(30);
    expect(targetReps('12')).toBe(12);
    expect(targetReps('AMRAP')).toBeNull();
    expect(targetReps('0')).toBeNull();
  });
});

describe('parseLogSetBody', () => {
  it('accepts a weighted set and stores grams', () => {
    expect(parseLogSetBody({ weightKg: 17.5, reps: 10 })).toEqual({
      ok: true,
      value: { weightGrams: 17500, reps: 10 },
    });
    expect(parseLogSetBody({ weightKg: 22.25, reps: 8 })).toEqual({
      ok: true,
      value: { weightGrams: 22250, reps: 8 },
    });
  });

  it('accepts bodyweight as null', () => {
    expect(parseLogSetBody({ weightKg: null, reps: 12 })).toEqual({
      ok: true,
      value: { weightGrams: null, reps: 12 },
    });
  });

  it('refuses zero, negative, huge or over-precise weights, and bad reps', () => {
    for (const weightKg of [0, -5, 501, 12.345, Number.NaN, '20']) {
      expect(parseLogSetBody({ weightKg, reps: 10 }).ok).toBe(false);
    }
    for (const reps of [0, 201, 7.5, '10', null]) {
      expect(parseLogSetBody({ weightKg: 20, reps }).ok).toBe(false);
    }
  });

  it('refuses unknown fields and non-objects', () => {
    expect(parseLogSetBody({ weightKg: 20, reps: 10, done: true }).ok).toBe(false);
    expect(parseLogSetBody([]).ok).toBe(false);
    expect(parseLogSetBody(null).ok).toBe(false);
  });
});

const ex = (name: string, sets = 3): SessionExercise => ({
  name,
  muscles: null,
  sets,
  reps: '10',
  restSeconds: 90,
});

describe('sessionStats', () => {
  const exercises = [ex('Leg press'), ex('Shoulder press'), ex('Dead bug')];

  it('counts sets, exercises and weighted volume', () => {
    const stats = sessionStats(
      exercises,
      [
        { exerciseIndex: 0, weightKg: 80, reps: 12 },
        { exerciseIndex: 0, weightKg: 80, reps: 11 },
        { exerciseIndex: 2, weightKg: null, reps: 8 },
      ],
      [null, null, null],
    );
    expect(stats.setsDone).toBe(3);
    expect(stats.exercisesDone).toBe(2);
    expect(stats.volumeKg).toBe(80 * 12 + 80 * 11);
    expect(stats.perExercise[1]).toEqual({
      name: 'Shoulder press',
      setsDone: 0,
      plannedSets: 3,
      top: null,
    });
    expect(stats.perExercise[0].top).toEqual({ weightKg: 80, reps: 12 });
  });

  it('reports a new best only above a previous best, never on a first log', () => {
    const stats = sessionStats(
      exercises,
      [
        { exerciseIndex: 0, weightKg: 85, reps: 10 },
        { exerciseIndex: 1, weightKg: 14, reps: 10 },
      ],
      [80, null, null],
    );
    expect(stats.bests).toEqual([
      { exerciseName: 'Leg press', weightKg: 85, reps: 10, previousKg: 80 },
    ]);
  });

  it('does not call an equal weight a new best', () => {
    const stats = sessionStats(
      exercises,
      [{ exerciseIndex: 0, weightKg: 80, reps: 15 }],
      [80, null, null],
    );
    expect(stats.bests).toEqual([]);
  });

  it('adds fractional kilos without float drift', () => {
    const stats = sessionStats(
      [ex('Row')],
      [
        { exerciseIndex: 0, weightKg: 37.5, reps: 10 },
        { exerciseIndex: 0, weightKg: 22.25, reps: 4 },
      ],
      [null],
    );
    expect(stats.volumeKg).toBe(Math.round(37.5 * 10 + 22.25 * 4));
  });
});

describe('finishInstant and durationMinutes', () => {
  const now = new Date('2026-09-30T12:00:00Z');

  it('finishes at now when the last set was recent', () => {
    const last = new Date(now.getTime() - 10 * 60_000);
    expect(finishInstant(last, now)).toBe(now);
  });

  it('finishes at the last set when the session sat idle', () => {
    const last = new Date(now.getTime() - SESSION_IDLE_CLOSE_MS - 1);
    expect(finishInstant(last, now)).toBe(last);
  });

  it('rounds to whole minutes, never below one', () => {
    expect(durationMinutes(new Date(0), new Date(46 * 60_000 + 20_000))).toBe(46);
    expect(durationMinutes(new Date(0), new Date(10_000))).toBe(1);
  });
});
