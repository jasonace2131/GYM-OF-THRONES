import { describe, expect, it } from 'vitest';
import { SESSION_IDLE_CLOSE_MS, type WorkoutSessionView } from '@got/shared';
import { SESSION, TODAY } from './fixtures';
import {
  addSet,
  allDone,
  applyOps,
  exerciseCard,
  firstOpenRow,
  goTo,
  hasDone,
  initSession,
  lastTimeLabel,
  leftOpen,
  loggedSets,
  nextSetNumber,
  offersFinish,
  parseRepsInput,
  progress,
  segments,
  setReps,
  startedBefore,
  startedLabel,
  statsOf,
  stepReps,
  toView,
  toggleSet,
  viewProgress,
} from './sessionState';

const NOW = '2026-09-30T10:40:00.000Z';
const values = (rows: { reps: number; done: boolean }[]) =>
  rows.map((r) => `${r.reps}${r.done ? '✓' : ''}`);

describe('initSession', () => {
  it('lays out the rows of PhoneSession.dc.html from the snapshot and the logged sets', () => {
    const model = initSession(SESSION);
    expect(model.rows.map((r) => r.length)).toEqual([3, 3, 3, 2, 3]);
    expect(values(model.rows[0]!)).toEqual(['12✓', '12✓', '11✓']);
    expect(values(model.rows[1]!)).toEqual(['12✓', '12✓', '10✓']);
    // Set 1 is ticked today; the sets after it follow its reps.
    expect(values(model.rows[2]!)).toEqual(['10✓', '10', '10']);
    // Last time was 2 × 10.
    expect(values(model.rows[3]!)).toEqual(['10', '10']);
    // Never logged: the target's first number.
    expect(values(model.rows[4]!)).toEqual(['8', '8', '8']);
  });

  it('carries no weight on any row, even where the server holds one', () => {
    const rows = initSession(SESSION).rows.flat();
    expect(rows.every((row) => !('weightKg' in row))).toBe(true);
  });

  it('opens on the first exercise that is not finished, or where it was left', () => {
    expect(initSession(SESSION).current).toBe(2);
    expect(initSession(SESSION, 4).current).toBe(4);
    expect(initSession(SESSION, 99).current).toBe(4);
    expect(initSession({ ...SESSION, sets: [] }).current).toBe(0);
  });

  it('prefills from last time when there is no set today, set by set', () => {
    const model = initSession({ ...SESSION, sets: [] });
    expect(values(model.rows[0]!)).toEqual(['12', '12', '11']);
    // Last time had two sets; the third repeats the last of them.
    expect(values(model.rows[1]!)).toEqual(['12', '12', '12']);
  });

  it('keeps a logged set beyond the plan, and falls back to 10 reps for "AMRAP"', () => {
    const view: WorkoutSessionView = {
      ...SESSION,
      exercises: [{ ...SESSION.exercises[4]!, reps: 'AMRAP' }],
      sets: [{ exerciseIndex: 0, setIndex: 4, weightKg: 5, reps: 12, completedAt: NOW }],
    };
    const model = initSession(view);
    expect(model.rows[0]).toHaveLength(5);
    expect(values(model.rows[0]!)).toEqual(['10', '10', '10', '10', '12✓']);
  });
});

describe('toggleSet', () => {
  it('ticks a set: a bodyweight PUT for the queue, and the sets after it follow its reps', () => {
    // Leg press, logged at 80 kg last time: the PUT still carries no weight.
    const model = initSession({ ...SESSION, sets: [] });
    const edited = stepReps(model, 0, 0, 1).model; // 13
    const { model: next, op, done } = toggleSet(edited, 0, 0, NOW);
    expect(done).toBe(true);
    expect(op).toEqual({
      kind: 'put',
      sessionId: 'sess-1',
      exerciseIndex: 0,
      setIndex: 0,
      body: { weightKg: null, reps: 13 },
    });
    expect(next.rows[0]![0]).toMatchObject({ done: true, completedAt: NOW });
    expect(values(next.rows[0]!)).toEqual(['13✓', '13', '13']);
  });

  it('unticks a set: a DELETE, and the row keeps what it showed', () => {
    const model = initSession(SESSION);
    const { model: next, op, done } = toggleSet(model, 2, 0, NOW);
    expect(done).toBe(false);
    expect(op).toEqual({ kind: 'delete', sessionId: 'sess-1', exerciseIndex: 2, setIndex: 0 });
    expect(next.rows[2]![0]).toMatchObject({ reps: 10, done: false });
    expect(next.rows[2]![0]!.completedAt).toBeNull();
  });

  it('leaves a set the member changed alone when an earlier set is ticked', () => {
    let model = initSession({ ...SESSION, sets: [] });
    model = setReps(model, 0, 2, 6).model;
    model = toggleSet(stepReps(model, 0, 0, 1).model, 0, 0, NOW).model;
    expect(values(model.rows[0]!)).toEqual(['13✓', '13', '6']);
  });
});

describe('stepReps and setReps', () => {
  const fresh = () => initSession({ ...SESSION, sets: [] });

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
      body: { weightKg: null, reps: 12 },
    });
    expect(stepReps(fresh(), 0, 0, 1).op).toBeNull();
  });
});

describe('parseRepsInput', () => {
  it('reads whole reps from 1 to 200', () => {
    expect(parseRepsInput('12')).toEqual({ ok: true, value: 12 });
    expect(parseRepsInput(' 8 ')).toEqual({ ok: true, value: 8 });
    expect(parseRepsInput('0')).toEqual({ ok: false });
    expect(parseRepsInput('201')).toEqual({ ok: false });
    expect(parseRepsInput('')).toEqual({ ok: false });
    expect(parseRepsInput('7.5')).toEqual({ ok: false });
  });
});

describe('addSet and goTo', () => {
  it('adds a set that copies the last row, up to 20', () => {
    let model = initSession(SESSION);
    model = addSet(model, 3);
    expect(values(model.rows[3]!)).toEqual(['10', '10', '10']);
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
    expect(values(model.rows[3]!)).toEqual(['10', '10', '10', '12✓']);
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

  it('counts what is on screen: sets, but no weight, so no volume and no new best', () => {
    const stats = statsOf(initSession(SESSION));
    expect(stats.setsDone).toBe(7);
    expect(stats.volumeKg).toBe(0);
    expect(stats.bests).toEqual([]);
    expect(stats.perExercise[0]!.top).toEqual({ weightKg: null, reps: 12 });
  });

  it('knows the next set to rest for, and that there is none once the exercise is done', () => {
    const model = initSession(SESSION);
    expect(firstOpenRow(model, 2)).toBe(1);
    expect(nextSetNumber(model, 2)).toBe(2);
    expect(firstOpenRow(model, 0)).toBe(-1);
    // Was 3, a "Next set 3" rest after the third and last set.
    expect(nextSetNumber(model, 0)).toBeNull();
  });
});

describe('offersFinish', () => {
  const tickAll = (from: ReturnType<typeof initSession>) => {
    let model = from;
    model.rows.forEach((rows, e) =>
      rows.forEach((row, s) => {
        if (!row.done) model = toggleSet(model, e, s, NOW).model;
      }),
    );
    return model;
  };

  it('is on the last exercise, resting or not, and nowhere else while sets are open', () => {
    const model = initSession(SESSION);
    expect(offersFinish(goTo(model, 4))).toBe(true);
    expect(offersFinish(goTo(model, 2))).toBe(false);
    expect(offersFinish(goTo(model, 0))).toBe(false);
  });

  it('is on every exercise once every set is ticked', () => {
    const model = tickAll(initSession(SESSION));
    expect(allDone(model)).toBe(true);
    expect([0, 1, 2, 3, 4].map((i) => offersFinish(goTo(model, i)))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });
});

describe('a workout left open', () => {
  const started = Date.parse(SESSION.startedAt);
  const lastSet = Date.parse('2026-09-30T10:30:00.000Z');

  it('is one from an earlier gym day', () => {
    expect(startedBefore(SESSION, TODAY)).toBe(false);
    expect(startedBefore(SESSION, '2026-10-01' as typeof TODAY)).toBe(true);
    expect(leftOpen(SESSION, '2026-10-01' as typeof TODAY, lastSet + 60_000)).toBe(true);
  });

  it('is one untouched for longer than the idle window, from its last set or its start', () => {
    expect(leftOpen(SESSION, TODAY, lastSet + SESSION_IDLE_CLOSE_MS)).toBe(false);
    expect(leftOpen(SESSION, TODAY, lastSet + SESSION_IDLE_CLOSE_MS + 1)).toBe(true);
    const empty = { ...SESSION, sets: [] };
    expect(leftOpen(empty, TODAY, started + SESSION_IDLE_CLOSE_MS)).toBe(false);
    expect(leftOpen(empty, TODAY, started + SESSION_IDLE_CLOSE_MS + 1)).toBe(true);
  });

  it('says when it started: the time today, the date before today', () => {
    expect(startedLabel(SESSION, TODAY)).toBe('Started 6:12 PM');
    expect(startedLabel(SESSION, '2026-10-02' as typeof TODAY)).toBe('Started Wed, Sep 30');
  });
});

describe('loggedSets and toView', () => {
  it('writes the done rows back as the view the cache keeps, as bodyweight', () => {
    const model = initSession(SESSION);
    const asLogged = SESSION.sets.map((set) => ({ ...set, weightKg: null }));
    expect(loggedSets(model)).toEqual(asLogged);
    expect(toView(SESSION, model)).toEqual({ ...SESSION, sets: asLogged });
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

  it('names last time as sets × reps, an old weighted top set in kg, or nothing', () => {
    expect(lastTimeLabel(SESSION.exercises[0]!.lastTime)).toBe('Last time 80 kg × 12');
    expect(lastTimeLabel(SESSION.exercises[3]!.lastTime)).toBe('Last time 2 × 10');
    const reps = (...counts: number[]) => ({
      date: '2026-09-23',
      sets: counts.map((n) => ({ weightKg: null, reps: n })),
    });
    expect(lastTimeLabel(reps(12, 10, 8))).toBe('Last time 3 sets, up to 12 reps');
    expect(lastTimeLabel(reps(15))).toBe('Last time 15 reps');
    expect(lastTimeLabel(reps(1))).toBe('Last time 1 rep');
    expect(lastTimeLabel(null)).toBeNull();
    expect(lastTimeLabel({ date: '2026-09-23', sets: [] })).toBeNull();
  });

  it('shows no muscles line for a coach exercise, which records none', () => {
    const view = { ...SESSION, exercises: [{ ...SESSION.exercises[0]!, muscles: null }] };
    expect(exerciseCard(initSession(view), 0).muscles).toBeNull();
  });
});
