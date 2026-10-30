import {
  SESSION_IDLE_CLOSE_MS,
  SESSION_LIMITS,
  sessionStats,
  targetReps,
  type LastTime,
  type LoggedSet,
  type SessionExerciseView,
  type WorkoutSessionView,
} from '@got/shared';
import type { CivilDate } from '@/lib/gymTime';
import { gymClock12 } from '@/lib/schedule/gymClock';
import { kgText, repsWord, sessionDate } from './history';
import { doseLine } from './planView';
import type { SyncOp } from './syncQueue';

/**
 * The session screen's state (PhoneSession.dc.html), as pure functions.
 *
 * One exercise on screen at a time; each exercise is a list of set ROWS —
 * the planned ones, any extra the member added, and any the server already
 * holds. A row is done (ticked, and therefore stored) or not; only done rows
 * ever reach the server. Every change that touches a done row returns the
 * `SyncOp` the queue must send, so the screen can never change a stored set
 * without saying so.
 *
 * A row is reps only. The screen stopped asking for a weight (owner,
 * 2026-10-30), so every set it logs is stored as bodyweight (`weightKg: null`
 * on every PUT); sets logged with a weight before then keep it on the server,
 * and "Last time" still names it.
 *
 * Prefill, for a row nobody has touched: the reps of the nearest set ticked
 * above it TODAY, else of the same set LAST TIME, else the plan's first rep
 * number (spec §5).
 */

/** Reps for a target with no number in it ("AMRAP"). */
export const FALLBACK_REPS = 10;

export interface SetRow {
  reps: number;
  done: boolean;
  completedAt: string | null;
  /** The member set these numbers (or ticked them) — prefill leaves them alone. */
  edited: boolean;
}

export interface SessionModel {
  id: string;
  exercises: SessionExerciseView[];
  rows: SetRow[][];
  /** The exercise on screen. */
  current: number;
}

export interface Change {
  model: SessionModel;
  /** What the sync queue must send, or null when nothing stored changed. */
  op: SyncOp | null;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function lastTimeRow(lastTime: LastTime | null, setIndex: number) {
  if (lastTime === null || lastTime.sets.length === 0) return null;
  return lastTime.sets[Math.min(setIndex, lastTime.sets.length - 1)] ?? null;
}

function prefill(
  exercise: SessionExerciseView,
  rows: readonly SetRow[],
  setIndex: number,
): Pick<SetRow, 'reps'> {
  for (let k = setIndex - 1; k >= 0; k -= 1) {
    const above = rows[k];
    if (above?.done) return { reps: above.reps };
  }
  const last = lastTimeRow(exercise.lastTime, setIndex);
  if (last !== null) return { reps: last.reps };
  return { reps: targetReps(exercise.reps) ?? FALLBACK_REPS };
}

/** Re-prefills the untouched, unticked rows of one exercise. */
function refill(exercise: SessionExerciseView, rows: readonly SetRow[]): SetRow[] {
  const out: SetRow[] = [];
  rows.forEach((row, j) => {
    out.push(row.done || row.edited ? row : { ...row, ...prefill(exercise, out, j) });
  });
  return out;
}

function blankRow(): SetRow {
  return { reps: FALLBACK_REPS, done: false, completedAt: null, edited: false };
}

export function isComplete(rows: readonly SetRow[]): boolean {
  return rows.length > 0 && rows.every((row) => row.done);
}

function firstIncomplete(rows: readonly SetRow[][]): number {
  const index = rows.findIndex((r) => !isComplete(r));
  return index === -1 ? Math.max(0, rows.length - 1) : index;
}

export function initSession(view: WorkoutSessionView, current?: number | null): SessionModel {
  const rows = view.exercises.map((exercise, i) => {
    const mine = view.sets.filter((s) => s.exerciseIndex === i);
    const highest = mine.reduce((max, s) => Math.max(max, s.setIndex + 1), 0);
    const count = clamp(Math.max(exercise.sets, highest), 1, SESSION_LIMITS.setsPerExerciseMax);
    const list: SetRow[] = Array.from({ length: count }, (_, j) => {
      const set = mine.find((s) => s.setIndex === j);
      return set === undefined
        ? blankRow()
        : { reps: set.reps, done: true, completedAt: set.completedAt, edited: true };
    });
    return refill(exercise, list);
  });
  const last = Math.max(0, view.exercises.length - 1);
  return {
    id: view.id,
    exercises: view.exercises,
    rows,
    current:
      current === undefined || current === null ? firstIncomplete(rows) : clamp(current, 0, last),
  };
}

function withRows(model: SessionModel, e: number, rows: SetRow[]): SessionModel {
  return { ...model, rows: model.rows.map((r, i) => (i === e ? rows : r)) };
}

function putOp(model: SessionModel, e: number, s: number, row: SetRow): SyncOp {
  return {
    kind: 'put',
    sessionId: model.id,
    exerciseIndex: e,
    setIndex: s,
    body: { weightKg: null, reps: row.reps },
  };
}

/** Changes one row's reps, from 1 to 200; a done row is re-sent. */
export function setReps(model: SessionModel, e: number, s: number, reps: number): Change {
  const row = model.rows[e]?.[s];
  if (row === undefined) return { model, op: null };
  const value = clamp(Math.round(reps), 1, SESSION_LIMITS.repsMax);
  if (value === row.reps) return { model, op: null };
  const next: SetRow = { ...row, reps: value, edited: true };
  const rows = (model.rows[e] ?? []).map((r, j) => (j === s ? next : r));
  return {
    model: withRows(model, e, rows),
    op: next.done ? putOp(model, e, s, next) : null,
  };
}

/** ±1 rep, from 1 to 200. */
export function stepReps(model: SessionModel, e: number, s: number, direction: 1 | -1): Change {
  const row = model.rows[e]?.[s];
  if (row === undefined) return { model, op: null };
  return setReps(model, e, s, row.reps + direction);
}

/** Tick → PUT; untick → DELETE. `done` is the row's new state. */
export function toggleSet(
  model: SessionModel,
  e: number,
  s: number,
  nowIso: string,
): Change & { done: boolean } {
  const exercise = model.exercises[e];
  const row = model.rows[e]?.[s];
  if (exercise === undefined || row === undefined) return { model, op: null, done: false };
  const done = !row.done;
  const next: SetRow = { ...row, done, completedAt: done ? nowIso : null, edited: true };
  const rows = refill(
    exercise,
    (model.rows[e] ?? []).map((r, j) => (j === s ? next : r)),
  );
  return {
    model: withRows(model, e, rows),
    op: done
      ? putOp(model, e, s, next)
      : { kind: 'delete', sessionId: model.id, exerciseIndex: e, setIndex: s },
    done,
  };
}

/** "Add a set": a copy of the last row, unticked. At most 20. */
export function addSet(model: SessionModel, e: number): SessionModel {
  const rows = model.rows[e];
  if (rows === undefined || rows.length >= SESSION_LIMITS.setsPerExerciseMax) return model;
  const last = rows[rows.length - 1];
  const row: SetRow = {
    reps: last?.reps ?? FALLBACK_REPS,
    done: false,
    completedAt: null,
    edited: false,
  };
  return withRows(model, e, [...rows, row]);
}

export function goTo(model: SessionModel, index: number): SessionModel {
  const current = clamp(index, 0, Math.max(0, model.exercises.length - 1));
  return current === model.current ? model : { ...model, current };
}

/**
 * Replays this session's unsent queue over what the server returned, so a
 * reload with no signal still shows every set the member ticked.
 */
export function applyOps(
  model: SessionModel,
  ops: readonly SyncOp[],
  nowIso: string,
): SessionModel {
  let rows = model.rows.map((r) => [...r]);
  for (const op of ops) {
    if (op.sessionId !== model.id) continue;
    const list = rows[op.exerciseIndex];
    if (list === undefined || op.setIndex >= SESSION_LIMITS.setsPerExerciseMax) continue;
    while (list.length <= op.setIndex) list.push(blankRow());
    const row = list[op.setIndex] as SetRow;
    list[op.setIndex] =
      op.kind === 'put'
        ? { reps: op.body.reps, done: true, completedAt: row.completedAt ?? nowIso, edited: true }
        : { ...row, done: false, completedAt: null, edited: true };
  }
  rows = rows.map((list, i) => {
    const exercise = model.exercises[i];
    return exercise === undefined ? list : refill(exercise, list);
  });
  return { ...model, rows };
}

/** The done rows as this screen logs them: reps, and bodyweight. */
export function loggedSets(model: SessionModel): LoggedSet[] {
  const out: LoggedSet[] = [];
  model.rows.forEach((rows, exerciseIndex) =>
    rows.forEach((row, setIndex) => {
      if (row.done) {
        out.push({
          exerciseIndex,
          setIndex,
          weightKg: null,
          reps: row.reps,
          completedAt: row.completedAt ?? '',
        });
      }
    }),
  );
  return out;
}

/** The view with this screen's sets in it — what the device cache keeps. */
export function toView(view: WorkoutSessionView, model: SessionModel): WorkoutSessionView {
  return { ...view, sets: loggedSets(model) };
}

export function firstOpenRow(model: SessionModel, e: number): number {
  return (model.rows[e] ?? []).findIndex((row) => !row.done);
}

/**
 * "REST · NEXT SET 3", or null once every set of the exercise is ticked.
 * There is then no set to rest for, and no rest: the next step is the next
 * exercise, and moving to it ends a rest anyway.
 */
export function nextSetNumber(model: SessionModel, e: number): number | null {
  const open = firstOpenRow(model, e);
  return open === -1 ? null : open + 1;
}

export function hasDone(model: SessionModel): boolean {
  return model.rows.some((rows) => rows.some((row) => row.done));
}

export function allDone(model: SessionModel): boolean {
  return model.rows.every(isComplete);
}

/**
 * Finish workout is on the bottom bar on the last exercise, resting or not,
 * and on every exercise once every set is ticked. It used to be on the last
 * exercise only, and gone while a rest ran there, so a member who had done
 * everything could see no way to finish but End at the top.
 */
export function offersFinish(model: SessionModel): boolean {
  return model.current === model.exercises.length - 1 || allDone(model);
}

/** Started on an earlier gym day than `today`. */
export function startedBefore(
  view: Pick<WorkoutSessionView, 'businessDate'>,
  today: CivilDate,
): boolean {
  return view.businessDate < today;
}

/**
 * A workout the member walked away from: started on an earlier gym day, or
 * untouched (no set ticked, or none since it started) for longer than
 * `SESSION_IDLE_CLOSE_MS`, the server's own rule for a forgotten session.
 * Coming back to one asks whether to finish or discard it rather than
 * resuming a clock that ran all night.
 */
export function leftOpen(
  view: Pick<WorkoutSessionView, 'businessDate' | 'startedAt' | 'sets'>,
  today: CivilDate,
  nowMs: number,
): boolean {
  if (startedBefore(view, today)) return true;
  const last = view.sets.reduce((latest, set) => {
    const at = Date.parse(set.completedAt);
    return Number.isNaN(at) ? latest : Math.max(latest, at);
  }, Date.parse(view.startedAt));
  return nowMs - last > SESSION_IDLE_CLOSE_MS;
}

/** "Started 6:12 PM", or "Started Wed, Sep 30" for a workout from an earlier gym day. */
export function startedLabel(
  view: Pick<WorkoutSessionView, 'businessDate' | 'startedAt'>,
  today: CivilDate,
): string {
  return `Started ${startedBefore(view, today) ? sessionDate(view.businessDate) : gymClock12(view.startedAt)}`;
}

export type Segment = 'done' | 'current' | 'todo';

/** The bar under the header: green when every set is ticked, gold for the one on screen. */
export function segments(model: SessionModel): Segment[] {
  return model.rows.map((rows, i) =>
    isComplete(rows) ? 'done' : i === model.current ? 'current' : 'todo',
  );
}

export function progress(model: SessionModel): {
  complete: number;
  total: number;
  setsDone: number;
} {
  return {
    complete: model.rows.filter(isComplete).length,
    total: model.exercises.length,
    setsDone: model.rows.reduce((sum, rows) => sum + rows.filter((r) => r.done).length, 0),
  };
}

/** The hub's "2 of 5 exercises done" and its bar, from the server's view alone. */
export function viewProgress(view: WorkoutSessionView) {
  const model = initSession(view);
  return { ...progress(model), segments: segments(model) };
}

/** The shared rule the summary uses, on what is on screen now. */
export function statsOf(model: SessionModel) {
  return sessionStats(
    model.exercises,
    loggedSets(model),
    model.exercises.map((e) => e.bestKg),
  );
}

export type Parsed<T> = { ok: true; value: T } | { ok: false };

export function parseRepsInput(text: string): Parsed<number> {
  const cleaned = text.trim();
  if (!/^\d+$/.test(cleaned)) return { ok: false };
  const value = Number(cleaned);
  return value >= 1 && value <= SESSION_LIMITS.repsMax ? { ok: true, value } : { ok: false };
}

/**
 * "Last time 3 × 12", "Last time 12 reps", or "Last time 3 sets, up to 12
 * reps" when the sets differed. A session logged with a weight, from before
 * the screen stopped asking for one, still names its top set: "Last time
 * 80 kg × 12".
 */
export function lastTimeLabel(lastTime: LastTime | null): string | null {
  if (lastTime === null || lastTime.sets.length === 0) return null;
  const { sets } = lastTime;
  let top = sets[0] as LastTime['sets'][number];
  for (const set of sets) {
    const w = set.weightKg ?? 0;
    const t = top.weightKg ?? 0;
    if (w > t || (w === t && set.reps > top.reps)) top = set;
  }
  if (top.weightKg !== null) return `Last time ${kgText(top.weightKg)} × ${top.reps}`;
  if (sets.length === 1) return `Last time ${repsWord(top.reps)}`;
  return sets.every((set) => set.reps === top.reps)
    ? `Last time ${sets.length} × ${top.reps}`
    : `Last time ${sets.length} sets, up to ${repsWord(top.reps)}`;
}

export interface ExerciseCardCopy {
  kicker: string;
  name: string;
  muscles: string | null;
  target: string;
  last: string | null;
  note: string | null;
}

export function exerciseCard(model: SessionModel, e: number): ExerciseCardCopy {
  const exercise = model.exercises[e] as SessionExerciseView;
  return {
    kicker: `EXERCISE ${e + 1} OF ${model.exercises.length}`,
    name: exercise.name,
    muscles: exercise.muscles,
    target: doseLine(exercise),
    last: lastTimeLabel(exercise.lastTime),
    note: exercise.notes ?? null,
  };
}
