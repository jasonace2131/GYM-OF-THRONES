import type { LogSetBody } from '@got/shared';
import { isApiError } from './errors';

/**
 * Every tick and untick on the session screen goes through this queue
 * (spec §5 "Offline"). A gym floor is where phones lose signal, so a set is
 * written to the phone FIRST and to the server when it can be.
 *
 * - PERSISTED in localStorage, so a reload, a crash or a dead battery keeps
 *   the sets that had not gone out yet.
 * - ORDERED: replayed oldest first.
 * - COALESCED by set: ticking, changing the weight and unticking one set
 *   leaves one op, the newest — safe because PUT and DELETE are idempotent by
 *   `(session, exercise, set)`, so only the last intent matters.
 * - DROPS an op the server refuses for good (404 gone, 409 finished, 400/422
 *   invalid) and asks the screen to resync; keeps and retries everything else
 *   (no signal, 5xx, 429, an expired sign-in).
 */

export const SYNC_STORAGE_KEY = 'got.workouts.sync.v1';

interface SetAddress {
  sessionId: string;
  exerciseIndex: number;
  setIndex: number;
}

export type SyncOp =
  ({ kind: 'put'; body: LogSetBody } & SetAddress) | ({ kind: 'delete' } & SetAddress);

export function opKey(op: SetAddress): string {
  return `${op.sessionId}/${op.exerciseIndex}/${op.setIndex}`;
}

/** The newest intent for a set replaces any older one, and goes to the back. */
export function enqueue(ops: readonly SyncOp[], op: SyncOp): SyncOp[] {
  const key = opKey(op);
  return [...ops.filter((o) => opKey(o) !== key), op];
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isOp(value: unknown): value is SyncOp {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v['sessionId'] !== 'string' || !isIndex(v['exerciseIndex']) || !isIndex(v['setIndex']))
    return false;
  if (v['kind'] === 'delete') return true;
  if (v['kind'] !== 'put') return false;
  const body = v['body'] as Record<string, unknown> | null | undefined;
  return (
    body !== null &&
    typeof body === 'object' &&
    typeof body['reps'] === 'number' &&
    (body['weightKg'] === null || typeof body['weightKg'] === 'number')
  );
}

/** Whatever was stored, minus anything that is not an op. Never throws. */
export function parseQueue(raw: string | null): SyncOp[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isOp) : [];
  } catch {
    return [];
  }
}

const PERMANENT = new Set([400, 404, 409, 410, 422]);

/** `drop` = it can never succeed; `retry` = it may, later. */
export function classifyFailure(caught: unknown): 'drop' | 'retry' {
  return isApiError(caught) && PERMANENT.has(caught.status) ? 'drop' : 'retry';
}

export interface QueueStorage {
  read(): string | null;
  write(value: string): void;
}

export function memoryStorage(initial: string | null = null): QueueStorage {
  let value = initial;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
  };
}

/** localStorage, forgiving: private mode or a full disk must not break a workout. */
export function browserStorage(key: string = SYNC_STORAGE_KEY): QueueStorage {
  return {
    read: () => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write: (value) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // The in-memory copy still syncs this visit.
      }
    },
  };
}

export interface QueueSnapshot {
  ops: readonly SyncOp[];
  flushing: boolean;
  /** The last flush stopped on a failure worth retrying — most likely no signal. */
  stalled: boolean;
}

export interface FlushResult {
  sent: number;
  dropped: number;
  stalled: boolean;
  /** Something was dropped: what is on screen may not be what the server has. */
  resync: boolean;
  /** The sessions that lost an op — a stale one from an old workout says nothing about the open one. */
  resyncSessions: string[];
}

export interface SyncQueue {
  snapshot(): QueueSnapshot;
  add(op: SyncOp): void;
  pending(sessionId: string): number;
  opsFor(sessionId: string): SyncOp[];
  /** Send everything, oldest first. One at a time: a second call shares the first. */
  flush(): Promise<FlushResult>;
  clear(sessionId: string): void;
}

export function createSyncQueue(deps: {
  storage: QueueStorage;
  send: (op: SyncOp) => Promise<unknown>;
  onChange?: (snapshot: QueueSnapshot) => void;
}): SyncQueue {
  let ops: SyncOp[] = parseQueue(deps.storage.read());
  let flushing = false;
  let stalled = false;
  let inFlight: Promise<FlushResult> | null = null;

  const snapshot = (): QueueSnapshot => ({ ops, flushing, stalled });
  const changed = (persist: boolean): void => {
    if (persist) deps.storage.write(JSON.stringify(ops));
    deps.onChange?.(snapshot());
  };
  // By identity: a newer edit to the same set may already have replaced it.
  const remove = (op: SyncOp): void => {
    ops = ops.filter((o) => o !== op);
    changed(true);
  };

  const run = async (): Promise<FlushResult> => {
    const result: FlushResult = {
      sent: 0,
      dropped: 0,
      stalled: false,
      resync: false,
      resyncSessions: [],
    };
    while (ops.length > 0) {
      const op = ops[0] as SyncOp;
      try {
        await deps.send(op);
        result.sent += 1;
        remove(op);
      } catch (caught) {
        if (classifyFailure(caught) === 'retry') {
          result.stalled = true;
          break;
        }
        result.dropped += 1;
        result.resync = true;
        if (!result.resyncSessions.includes(op.sessionId)) result.resyncSessions.push(op.sessionId);
        remove(op);
      }
    }
    return result;
  };

  return {
    snapshot,
    add(op) {
      ops = enqueue(ops, op);
      changed(true);
    },
    pending: (sessionId) => ops.filter((o) => o.sessionId === sessionId).length,
    opsFor: (sessionId) => ops.filter((o) => o.sessionId === sessionId),
    flush() {
      if (inFlight !== null) return inFlight;
      flushing = true;
      changed(false);
      inFlight = run().then((result) => {
        flushing = false;
        stalled = result.stalled;
        inFlight = null;
        changed(false);
        return result;
      });
      return inFlight;
    },
    clear(sessionId) {
      ops = ops.filter((o) => o.sessionId !== sessionId);
      changed(true);
    },
  };
}

export interface SyncLine {
  tone: 'ok' | 'busy' | 'warn';
  text: string;
}

/** The line under the exercise card (PhoneSession.dc.html), live. */
export function syncLine(input: {
  pending: number;
  flushing: boolean;
  offline: boolean;
}): SyncLine {
  const { pending, offline } = input;
  if (pending === 0) {
    return { tone: 'ok', text: 'Every set saves as you tick it — even with no signal.' };
  }
  if (offline) {
    return { tone: 'warn', text: `Offline — ${pending} ${pending === 1 ? 'set' : 'sets'} waiting` };
  }
  return { tone: 'busy', text: 'Saving…' };
}
