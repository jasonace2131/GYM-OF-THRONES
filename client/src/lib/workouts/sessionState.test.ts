import { describe, expect, it } from 'vitest';
import type { WorkoutSessionView } from '@got/shared';
import { SESSION } from './fixtures';
import {
  addSet,
  allDone,
  applyOps,
  exerciseCard,
  firstOpenRow,
  formatKg,
  goTo,
  hasDone,
  initSession,
  lastTimeLabel,
  loggedSets,
  nextSetNumber,
  parseRepsInput,
  parseWeightInput,
  progress,
  segments,
  setReps,
  setWeight,
  statsOf,
  stepReps,
  stepWeight,
  toView,
  toggleSet,
  viewProgress,
} from './sessionState';

const NOW = '2026-09-30T10:40:00.000Z';
const values = (rows: { weightKg: number | null; reps: number; done: boolean }[]) =>
  rows.map((r) => `${r.weightKg ?? 'BW'}x${r.reps}${r.done ? '✓' : ''}`);

describe('initSession', () => {
  it('lays out the rows of PhoneSession.dc.html from the snapshot and the logged sets', () => {
    const model = initSession(SESSION);
    expect(model.rows.map((r) => r.length)).toEqual([3, 3, 3, 2, 3]);
    expect(values(model.rows[0]!)).toEqual(['80x12✓', '80x12✓', '80x11✓']);
    expect(values(model.rows[1]!)).toEqual(['35x12✓', '35x12✓', '37.5x10✓']);
    // Set 1 went up to 14 kg today; the sets after it follow it, not last week's 12.
    expect(values(model.rows[2]!)).toEqual(['14x10✓', '14x10', '14x10']);
    // Last time was bodyweight × 10.
    expect(values(model.rows[3]!)).toEqual(['BWx10', 'BWx10']);
    // Never logged: the target's first number and no weight.
    expect(values(model.rows[4]!)).toEqual(['BWx8', 'BWx8', 'BWx8']);
  });

  it('opens on the first exercise that is not finished, or where it was left', () => {
    expect(initSession(SESSION).current).toBe(2);
    expect(initSession(SESSION, 4).current).toBe(4);
    expect(initSession(SESSION, 99).current).toBe(4);
    expect(initSession({ ...SESSION, sets: [] }).current).toBe(0);
  });

  it('prefills from last time when there is no set today, set by set', () => {
    const model = initSession({ ...SESSION, sets: [] });
    expect(values(model.rows[0]!)).toEqual(['80x12', '80x12', '80x11']);
    // Last time had two sets; the third repeats the last of them.
    expect(values(model.rows[1]!)).toEqual(['35x12', '35x12', '35x12']);
  });

  it('keeps a logged set beyond the plan, and falls back to 10 reps for "AMRAP"', () => {
    const view: WorkoutSessionView = {
      ...SESSION,
      exercises: [{ ...SESSION.exercises[4]!, reps: 'AMRAP' }],
      sets: [{ exerciseIndex: 0, setIndex: 4, weightKg: 5, reps: 12, completedAt: NOW }],
    };
    const model = initSession(view);
    expect(model.rows[0]).toHaveLength(5);
    expect(values(model.rows[0]!)).toEqual(['BWx10', 'BWx10', 'BWx10', 'BWx10', '5x12✓']);
  });
});

describe('toggleSet', () => {
  it('ticks a set: a PUT for the queue, and the sets after it follow its weight', () => {
    const model = initSession({ ...SESSION, sets: [] });
    const edited = stepWeight(model, 0, 0, 1).model; // 82.5
    const { model: next, op, done } = toggleSet(edited, 0, 0, NOW);
    expect(done).toBe(true);
    expect(op).toEqual({
      kind: 'put',
      sessionId: 'sess-1',
      exerciseIndex: 0,
      setIndex: 0,
      body: { weightKg: 82.5, reps: 12 },
    });
    expect(next.rows[0]![0]).toMatchObject({ done: true, completedAt: NOW });
    expect(values(next.rows[0]!)).toEqual(['82.5x12✓', '82.5x12', '82.5x12']);
  });

  it('unticks a set: a DELETE, and the row keeps what it showed', () => {
    const model = initSession(SESSION);
    const { model: next, op, done } = toggleSet(model, 2, 0, NOW);
    expect(done).toBe(false);
    expect(op).toEqual({ kind: 'delete', sessionId: 'sess-1', exerciseIndex: 2, setIndex: 0 });
    expect(next.rows[2]![0]).toMatchObject({ weightKg: 14, reps: 10, done: false });
    expect(next.rows[2]![0]!.completedAt).toBeNull();
  });

  it('leaves a set the member changed alone when an earlier set is ticked', () => {
    let model = initSession({ ...SESSION, sets: [] });
    model = setWeight(model, 0, 2, 60).model;
    model = toggleSet(stepWeight(model, 0, 0, 1).model, 0, 0, NOW).model;
    expect(values(model.rows[0]!)).toEqual(['82.5x12✓', '82.5x12', '60x11']);
  });
});

describe('stepWeight and stepReps', () => {
  const fresh = () => initSession({ ...SESSION, sets: [] });

  it('steps kg by 2.5; below 2.5 is bodyweight; 500 is the ceiling', () => {
    let model = fresh(); // dead bug, bodyweight
    model = stepWeight(model, 4, 0, 1).model;
    expect(model.rows[4]![0]!.weightKg).toBe(2.5);
    model = stepWeight(model, 4, 0, -1).model;
    expect(model.rows[4]![0]!.weightKg).toBeNull();
    const still = stepWeight(model, 4, 0, -1);
    expect(still.model).toBe(model);
    expect(still.op).toBeNull();
    model = setWeight(model, 4, 0, 499).model;
    expect(stepWeight(model, 4, 0, 1).model.rows[4]![0]!.weightKg).toBe(500);
  });

  it('keeps two decimals exact through repeated steps', () => {
    let model = setWeight(fresh(), 0, 0, 22.25).model;
    model = stepWeight(model, 0, 0, 1).model;
    expect(model.rows[0]![0]!.weightKg).toBe(24.75);
  });

  it('steps reps by one, from 1 to 200', () => {
    let model = setReps(fresh(), 0, 0, 1).model;
    expect(stepReps(model, 0, 0, -1).model).toBe(model);
    model = setReps(model, 0, 0, 200).model;
    expect(stepReps(model, 0, 0, 1).op).toBeNull();
    expect(stepReps(model, 0, 0, -1).model.rows[0]![0]!.reps).toBe(199);
  });

  it('re-sends a set that is already ticked when its numbers change', () => {
    const model = initSession(SESSION);
    const { op } = stepReps(model, 0, 2, 1);
    expect(op).toEqual({
      kind: 'put',
      sessionId: 'sess-1',
      exerciseIndex: 0,
      setIndex: 2,
      body: { weightKg: 80, reps: 12 },
    });
    expect(stepWeight(fresh(), 0, 0, 1).op).toBeNull();
  });
});

describe('parseWeightInput and parseRepsInput', () => {
  it('reads what a member types into the kg box', () => {
    expect(parseWeightInput('82.5')).toEqual({ ok: true, value: 82.5 });
    expect(parseWeightInput(' 82,5 ')).toEqual({ ok: true, value: 82.5 });
    expect(parseWeightInput('80.')).toEqual({ ok: true, value: 80 });
    expect(parseWeightInput('17.125')).toEqual({ ok: true, value: 17.13 });
    expect(parseWeightInput('')).toEqual({ ok: true, value: null });
    expect(parseWeightInput('BW')).toEqual({ ok: true, value: null });
    expect(parseWeightInput('0')).toEqual({ ok: true, value: null });
    expect(parseWeightInput('600')).toEqual({ ok: false });
    expect(parseWeightInput('12kg')).toEqual({ ok: false });
    expect(parseWeightInput('.')).toEqual({ ok: false });
  });

  it('reads whole reps from 1 to 200', () => {
    expect(parseRepsInput('12')).toEqual({ ok: true, value: 12 });
    expect(parseRepsInput(' 8 ')).toEqual({ ok: true, value: 8 });
    expect(parseRepsInput('0')).toEqual({ ok: false });
    expect(parseRepsInput('201')).toEqual({ ok: false });
    expect(parseRepsInput('')).toEqual({ ok: false });
    expect(parseRepsInput('7.5')).toEqual({ ok: false });
  });

  it('writes kg the way the steppers show it', () => {
    expect(formatKg(80)).toBe('80');
    expect(formatKg(37.5)).toBe('37.5');
    expect(formatKg(22.25)).toBe('22.25');
    expect(formatKg(null)).toBe('BW');
  });
});

describe('addSet and goTo', () => {
  it('adds a set that copies the last row, up to 20', () => {
    let model = initSession(SESSION);
    model = addSet(model, 3);
    expect(values(model.rows[3]!)).toEqual(['BWx10', 'BWx10', 'BWx10']);
    for (let i = 0; i < 30; i += 1) model = addSet(model, 3);
    expect(model.rows[3]).toHaveLength(20);
  });

  it('moves between exercises without leaving the day', () => {
    const model = initSession(SESSION);
    expect(goTo(model, 3).current).toBe(3);
    expect(goTo(model, -1).current).toBe(0);
    expect(goTo(model, 9).current).toBe(4);
  });
});

describe('applyOps', () => {
  it("replays the queue's unsent ticks over what the server returned", () => {
    const model = applyOps(
      initSession(SESSION),
      [
        { kind: 'delete', sessionId: 'sess-1', exerciseIndex: 2, setIndex: 0 },
        {
          kind: 'put',
          sessionId: 'sess-1',
          exerciseIndex: 3,
          setIndex: 3,
          body: { weightKg: null, reps: 12 },
        },
        {
          kind: 'put',
          sessionId: 'another',
          exerciseIndex: 4,
          setIndex: 0,
          body: { weightKg: 5, reps: 5 },
        },
      ],
      NOW,
    );
    expect(model.rows[2]![0]!.done).toBe(false);
    expect(values(model.rows[3]!)).toEqual(['BWx10', 'BWx10', 'BWx10', 'BWx12✓']);
    expect(model.rows[4]!.some((r) => r.done)).toBe(false);
  });
});

describe('progress, segments and stats', () => {
  it('is "2 of 5 exercises done" with the third one current', () => {
    const model = initSession(SESSION);
    expect(segments(model)).toEqual(['done', 'done', 'current', 'todo', 'todo']);
    expect(progress(model)).toEqual({ complete: 2, total: 5, setsDone: 7 });
    expect(viewProgress(SESSION)).toEqual({
      complete: 2,
      total: 5,
      setsDone: 7,
      segments: ['done', 'done', 'current', 'todo', 'todo'],
    });
    expect(hasDone(model)).toBe(true);
    expect(allDone(model)).toBe(false);
    expect(hasDone(initSession({ ...SESSION, sets: [] }))).toBe(false);
  });

  it('counts a new best against the previous best from the snapshot', () => {
    const stats = statsOf(initSession(SESSION));
    expect(stats.setsDone).toBe(7);
    expect(stats.bests).toEqual([
      { exerciseName: 'Seated cable row', weightKg: 37.5, reps: 10, previousKg: 35 },
      { exerciseName: 'Dumbbell shoulder press', weightKg: 14, reps: 10, previousKg: 12 },
    ]);
  });

  it('knows the next set to rest for', () => {
    const model = initSession(SESSION);
    expect(firstOpenRow(model, 2)).toBe(1);
    expect(nextSetNumber(model, 2)).toBe(2);
    expect(firstOpenRow(model, 0)).toBe(-1);
    expect(nextSetNumber(model, 0)).toBe(3);
  });
});

describe('loggedSets and toView', () => {
  it('writes the done rows back as the view the cache keeps', () => {
    const model = initSession(SESSION);
    expect(loggedSets(model)).toEqual(SESSION.sets);
    expect(toView(SESSION, model)).toEqual(SESSION);
  });
});

describe('exerciseCard and lastTimeLabel', () => {
  it('reads like the card in PhoneSession.dc.html', () => {
    expect(exerciseCard(initSession(SESSION), 2)).toEqual({
      kicker: 'EXERCISE 3 OF 5',
      name: 'Dumbbell shoulder press',
      muscles: 'Shoulders · triceps',
      target: '3 × 10 · rest 75 s',
      last: 'Last time 12 kg × 10',
      note: null,
    });
    expect(exerciseCard(initSession(SESSION), 0).note).toBe('Do not lock your knees at the top.');
  });

  it("names last time's top set, bodyweight in words, and nothing when there was none", () => {
    expect(lastTimeLabel(SESSION.exercises[0]!.lastTime)).toBe('Last time 80 kg × 12');
    expect(lastTimeLabel(SESSION.exercises[3]!.lastTime)).toBe('Last time bodyweight × 10');
    expect(lastTimeLabel(null)).toBeNull();
    expect(lastTimeLabel({ date: '2026-09-23', sets: [] })).toBeNull();
  });

  it('shows no muscles line for a coach exercise, which records none', () => {
    const view = { ...SESSION, exercises: [{ ...SESSION.exercises[0]!, muscles: null }] };
    expect(exerciseCard(initSession(view), 0).muscles).toBeNull();
  });
});
