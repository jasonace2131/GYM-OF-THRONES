import {
  SESSION_LIMITS,
  sessionStats,
  targetReps,
  type LastTime,
  type LoggedSet,
  type SessionExerciseView,
  type WorkoutSessionView,
} from '@got/shared';
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
 * Prefill, for a row nobody has touched: the nearest set ticked above it
 * TODAY (the weight you just lifted), else the same set LAST TIME, else the
 * plan's first rep number and no weight (spec §5).
 */

export const WEIGHT_STEP_KG = 2.5;
/** Reps for a target with no number in it ("AMRAP"). */
export const FALLBACK_REPS = 10;

export interface SetRow {
  /** Null = bodyweight ("BW"). */
  weightKg: number | null;
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

const round2 = (value: number): number => Math.round(value * 100) / 100;
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
): Pick<SetRow, 'weightKg' | 'reps'> {
  for (let k = setIndex - 1; k >= 0; k -= 1) {
    const above = rows[k];
    if (above?.done) return { weightKg: above.weightKg, reps: above.reps };
  }
  const last = lastTimeRow(exercise.lastTime, setIndex);
  if (last !== null) return { weightKg: last.weightKg, reps: last.reps };
  return { weightKg: null, reps: targetReps(exercise.reps) ?? FALLBACK_REPS };
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
  return { weightKg: null, reps: FALLBACK_REPS, done: false, completedAt: null, edited: false };
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
        : {
            weightKg: set.weightKg,
            reps: set.reps,
            done: true,
            completedAt: set.completedAt,
            edited: true,
          };
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
    body: { weightKg: row.weightKg, reps: row.reps },
  };
}

/** Changes one row's numbers; a done row is re-sent. */
function editRow(
  model: SessionModel,
  e: number,
  s: number,
  patch: Pick<SetRow, 'weightKg'> | Pick<SetRow, 'reps'>,
): Change {
  const row = model.rows[e]?.[s];
  if (row === undefined) return { model, op: null };
  const next: SetRow = { ...row, ...patch, edited: true };
  if (next.weightKg === row.weightKg && next.reps === row.reps) return { model, op: null };
  const rows = (model.rows[e] ?? []).map((r, j) => (j === s ? next : r));
  return {
    model: withRows(model, e, rows),
    op: next.done ? putOp(model, e, s, next) : null,
  };
}

export function setWeight(
  model: SessionModel,
  e: number,
  s: number,
  weightKg: number | null,
): Change {
  const value =
    weightKg === null || weightKg <= 0
      ? null
      : round2(clamp(weightKg, 0.01, SESSION_LIMITS.weightKgMax));
  return editRow(model, e, s, { weightKg: value });
}

export function setReps(model: SessionModel, e: number, s: number, reps: number): Change {
  return editRow(model, e, s, { reps: clamp(Math.round(reps), 1, SESSION_LIMITS.repsMax) });
}

/** ±2.5 kg. Below 2.5 is bodyweight; 500 is the ceiling. */
export function stepWeight(model: SessionModel, e: number, s: number, direction: 1 | -1): Change {
  const row = model.rows[e]?.[s];
  if (row === undefined) return { model, op: null };
  const next = round2((row.weightKg ?? 0) + direction * WEIGHT_STEP_KG);
  return setWeight(model, e, s, next <= 0 ? null : next);
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
    weightKg: last?.weightKg ?? null,
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
        ? {
            weightKg: op.body.weightKg,
            reps: op.body.reps,
            done: true,
            completedAt: row.completedAt ?? nowIso,
            edited: true,
          }
        : { ...row, done: false, completedAt: null, edited: true };
  }
  rows = rows.map((list, i) => {
    const exercise = model.exercises[i];
    return exercise === undefined ? list : refill(exercise, list);
  });
  return { ...model, rows };
}

/** The done rows as the server stores them. */
export function loggedSets(model: SessionModel): LoggedSet[] {
  const out: LoggedSet[] = [];
  model.rows.forEach((rows, exerciseIndex) =>
    rows.forEach((row, setIndex) => {
      if (row.done) {
        out.push({
          exerciseIndex,
          setIndex,
          weightKg: row.weightKg,
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

/** "REST · NEXT SET 3". */
export function nextSetNumber(model: SessionModel, e: number): number {
  const count = model.rows[e]?.length ?? 0;
  const open = firstOpenRow(model, e);
  return Math.min(count, (open === -1 ? count : open) + 1);
}

export function hasDone(model: SessionModel): boolean {
  return model.rows.some((rows) => rows.some((row) => row.done));
}

export function allDone(model: SessionModel): boolean {
  return model.rows.every(isComplete);
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

/** "80", "37.5", "BW". */
export function formatKg(weightKg: number | null): string {
  return weightKg === null ? 'BW' : String(round2(weightKg));
}

export type Parsed<T> = { ok: true; value: T } | { ok: false };

/**
 * The kg box: "82.5", "82,5" (a comma keyboard), blank or "BW" for
 * bodyweight, rounded to two decimals as the server stores it.
 */
export function parseWeightInput(text: string): Parsed<number | null> {
  const cleaned = text.trim().replace(',', '.');
  if (cleaned === '' || cleaned.toLowerCase() === 'bw') return { ok: true, value: null };
  if (!/^\d*\.?\d*$/.test(cleaned) || !/\d/.test(cleaned)) return { ok: false };
  const value = round2(Number(cleaned));
  if (!Number.isFinite(value) || value > SESSION_LIMITS.weightKgMax) return { ok: false };
  return { ok: true, value: value <= 0 ? null : value };
}

export function parseRepsInput(text: string): Parsed<number> {
  const cleaned = text.trim();
  if (!/^\d+$/.test(cleaned)) return { ok: false };
  const value = Number(cleaned);
  return value >= 1 && value <= SESSION_LIMITS.repsMax ? { ok: true, value } : { ok: false };
}

/** "Last time 80 kg × 12" — that session's top set; bodyweight in words. */
export function lastTimeLabel(lastTime: LastTime | null): string | null {
  if (lastTime === null || lastTime.sets.length === 0) return null;
  let top = lastTime.sets[0] as LastTime['sets'][number];
  for (const set of lastTime.sets) {
    const w = set.weightKg ?? 0;
    const t = top.weightKg ?? 0;
    if (w > t || (w === t && set.reps > top.reps)) top = set;
  }
  const weight = top.weightKg === null ? 'bodyweight' : `${formatKg(top.weightKg)} kg`;
  return `Last time ${weight} × ${top.reps}`;
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
