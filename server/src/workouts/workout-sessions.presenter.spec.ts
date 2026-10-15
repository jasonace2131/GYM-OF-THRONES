import type { SessionExercise } from '@got/shared';
import {
  coachPlanName,
  dayTitleOf,
  lastTimesOf,
  parseSnapshot,
  storageSlug,
  toCoachPlanInWorkouts,
  toLoggedSet,
  toSessionSummary,
  toSessionView,
  type SessionRow,
  type SetRow,
} from './workout-sessions.presenter';

/**
 * The wire shapes of workout sessions (feat/workout-sessions): what a stored
 * snapshot must look like to be shown, how grams become kilos, and how
 * "last time" and "best" attach to each exercise.
 */

const STARTED = new Date('2026-09-30T10:00:00.000Z');
const FINISHED = new Date('2026-09-30T10:46:20.000Z');

const ex = (name: string, over: Partial<SessionExercise> = {}): SessionExercise => ({
  name,
  muscles: 'Legs',
  sets: 3,
  reps: '8-12',
  restSeconds: 90,
  ...over,
});

const EXERCISES = [ex('Leg press'), ex('Shoulder press'), ex('Dead bug', { muscles: null })];

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: 's1',
  source: 'MEMBER_PLAN',
  planName: 'Strength base',
  coachFirstName: null,
  coachLastName: null,
  dayTitle: 'Full body A',
  weekday: 3,
  exercises: EXERCISES as unknown as SessionRow['exercises'],
  businessDate: new Date('2026-09-30T00:00:00.000Z'),
  startedAt: STARTED,
  finishedAt: null,
  feeling: null,
  ...over,
});

const set = (exerciseIndex: number, setIndex: number, over: Partial<SetRow> = {}): SetRow => ({
  exerciseIndex,
  setIndex,
  weightGrams: 80_000,
  reps: 10,
  completedAt: new Date(STARTED.getTime() + (exerciseIndex * 5 + setIndex + 1) * 60_000),
  ...over,
});

describe('parseSnapshot', () => {
  it('accepts what the start wrote, notes included', () => {
    const withNotes = [ex('Plank', { notes: 'Brace' })];
    expect(parseSnapshot(withNotes as unknown as SessionRow['exercises'])).toEqual(withNotes);
    expect(parseSnapshot(EXERCISES as unknown as SessionRow['exercises'])).toEqual(EXERCISES);
  });

  it('refuses anything that is not a list of 1-12 exercises', () => {
    const bad: unknown[] = [
      null,
      {},
      [],
      Array.from({ length: 13 }, () => ex('A')),
      [{ ...ex('A'), name: '' }],
      [{ ...ex('A'), sets: 0 }],
      [{ ...ex('A'), sets: 2.5 }],
      [{ ...ex('A'), reps: 12 }],
      [{ ...ex('A'), muscles: 3 }],
      [{ ...ex('A'), restSeconds: -1 }],
      [{ ...ex('A'), notes: 5 }],
      ['Leg press'],
    ];
    for (const value of bad) {
      expect(parseSnapshot(value as SessionRow['exercises'])).toBeNull();
    }
  });
});

describe('storageSlug', () => {
  it('is the shared slug for a normal name', () => {
    expect(storageSlug('Goblet Squat')).toBe('goblet-squat');
    expect(storageSlug('  Dead bug ')).toBe('dead-bug');
  });

  it('never returns an empty key — a name with no latin letters still gets a stable one', () => {
    const a = storageSlug('???');
    expect(a).toMatch(/^[a-z0-9-]{1,80}$/);
    expect(storageSlug('???')).toBe(a);
    expect(storageSlug('!!!')).not.toBe(a);
  });
});

describe('coachPlanName and dayTitleOf', () => {
  it("names the coach's plan after the coach, within 60 characters", () => {
    expect(coachPlanName({ firstName: 'Ana' })).toBe("Coach Ana's plan");
    expect(coachPlanName(null)).toBe("Your coach's plan");
    const long = coachPlanName({ firstName: 'A'.repeat(80) });
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("'s plan")).toBe(true);
  });

  it('clips a title to 40 characters with an ellipsis', () => {
    expect(dayTitleOf('  Upper body  ')).toBe('Upper body');
    const clipped = dayTitleOf('x'.repeat(80));
    expect(clipped).toHaveLength(40);
    expect(clipped.endsWith('…')).toBe(true);
    expect(dayTitleOf('y'.repeat(40))).toBe('y'.repeat(40));
  });
});

describe('toLoggedSet', () => {
  it('turns grams into kilos and bodyweight into null', () => {
    expect(toLoggedSet(set(0, 1, { weightGrams: 22_250 }))).toEqual({
      exerciseIndex: 0,
      setIndex: 1,
      weightKg: 22.25,
      reps: 10,
      completedAt: new Date(STARTED.getTime() + 2 * 60_000).toISOString(),
    });
    expect(toLoggedSet(set(2, 0, { weightGrams: null })).weightKg).toBeNull();
  });
});

describe('lastTimesOf', () => {
  it('groups the rows by slug, in order, with the civil date', () => {
    const map = lastTimesOf([
      { slug: 'leg-press', date: '2026-09-26', weightGrams: 75_000, reps: 12 },
      { slug: 'leg-press', date: '2026-09-26', weightGrams: 75_000, reps: 11 },
      { slug: 'dead-bug', date: '2026-09-24', weightGrams: null, reps: 8 },
    ]);
    expect(map.get('leg-press')).toEqual({
      date: '2026-09-26',
      sets: [
        { weightKg: 75, reps: 12 },
        { weightKg: 75, reps: 11 },
      ],
    });
    expect(map.get('dead-bug')).toEqual({
      date: '2026-09-24',
      sets: [{ weightKg: null, reps: 8 }],
    });
    expect(map.get('shoulder-press')).toBeUndefined();
  });
});

describe('toSessionView', () => {
  it('attaches last time and best per exercise, and lists the ticked sets', () => {
    const lastTimes = lastTimesOf([
      { slug: 'leg-press', date: '2026-09-26', weightGrams: 75_000, reps: 12 },
    ]);
    const bests = new Map([['leg-press', 80_000]]);

    const view = toSessionView(row(), EXERCISES, [set(0, 0), set(0, 1)], lastTimes, bests);

    expect(view).toMatchObject({
      id: 's1',
      source: 'MEMBER_PLAN',
      planName: 'Strength base',
      coach: null,
      dayTitle: 'Full body A',
      weekday: 3,
      businessDate: '2026-09-30',
      startedAt: STARTED.toISOString(),
      finishedAt: null,
      feeling: null,
    });
    expect(view.exercises[0]).toEqual({
      ...EXERCISES[0],
      lastTime: { date: '2026-09-26', sets: [{ weightKg: 75, reps: 12 }] },
      bestKg: 80,
    });
    expect(view.exercises[1]).toMatchObject({ lastTime: null, bestKg: null });
    expect(view.sets.map((s) => [s.exerciseIndex, s.setIndex])).toEqual([
      [0, 0],
      [0, 1],
    ]);
  });

  it("carries the coach's name on a coach-plan session", () => {
    const view = toSessionView(
      row({ source: 'COACH_PLAN', coachFirstName: 'Ana', coachLastName: 'Reyes', weekday: null }),
      EXERCISES,
      [],
      new Map(),
      new Map(),
    );
    expect(view.coach).toEqual({ firstName: 'Ana', lastName: 'Reyes' });
    expect(view.weekday).toBeNull();
  });
});

describe('toCoachPlanInWorkouts', () => {
  it("adds isActive and each day's weekday to the coach's plan", () => {
    const view = {
      plan: {
        summary: 'Three days.',
        days: ['Monday', 'Day 2', 'mon', 'Friday'].map((day) => ({
          day,
          focus: 'Full body',
          exercises: [{ name: 'Leg press', sets: 3, reps: '12' }],
        })),
      },
      coach: { firstName: 'Ana', lastName: 'Reyes' },
      updatedAt: STARTED.toISOString(),
    };
    expect(toCoachPlanInWorkouts(view, true)).toEqual({
      ...view,
      isActive: true,
      weekdays: [1, null, null, 5],
    });
    expect(toCoachPlanInWorkouts(view, false).isActive).toBe(false);
  });
});

describe('toSessionSummary', () => {
  it('summarises with the shared stats against the previous bests', () => {
    const summary = toSessionSummary(
      row({ finishedAt: FINISHED, feeling: 'RIGHT' }),
      EXERCISES,
      [
        set(0, 0, { weightGrams: 85_000, reps: 10 }),
        set(0, 1, { weightGrams: 80_000, reps: 12 }),
        set(2, 0, { weightGrams: null, reps: 8 }),
      ],
      new Map([
        ['leg-press', 80_000],
        ['dead-bug', 10_000],
      ]),
    );

    expect(summary).toEqual({
      id: 's1',
      source: 'MEMBER_PLAN',
      planName: 'Strength base',
      dayTitle: 'Full body A',
      businessDate: '2026-09-30',
      startedAt: STARTED.toISOString(),
      finishedAt: FINISHED.toISOString(),
      durationMinutes: 46,
      setsDone: 3,
      exercisesDone: 2,
      exerciseCount: 3,
      volumeKg: 85 * 10 + 80 * 12,
      bests: [{ exerciseName: 'Leg press', weightKg: 85, reps: 10, previousKg: 80 }],
      perExercise: [
        { name: 'Leg press', setsDone: 2, plannedSets: 3, top: { weightKg: 85, reps: 10 } },
        { name: 'Shoulder press', setsDone: 0, plannedSets: 3, top: null },
        { name: 'Dead bug', setsDone: 1, plannedSets: 3, top: { weightKg: null, reps: 8 } },
      ],
      feeling: 'RIGHT',
    });
  });

  it('refuses to summarise an open session', () => {
    expect(() => toSessionSummary(row(), EXERCISES, [], new Map())).toThrow(/open/);
  });
});
