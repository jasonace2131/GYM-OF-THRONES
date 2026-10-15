import { describe, expect, it, vi } from 'vitest';
import {
  SYNC_STORAGE_KEY,
  browserStorage,
  classifyFailure,
  createSyncQueue,
  enqueue,
  memoryStorage,
  opKey,
  parseQueue,
  syncLine,
  type SyncOp,
} from './syncQueue';

const put = (setIndex: number, weightKg: number | null, reps = 10, sessionId = 's1'): SyncOp => ({
  kind: 'put',
  sessionId,
  exerciseIndex: 0,
  setIndex,
  body: { weightKg, reps },
});
const del = (setIndex: number, sessionId = 's1'): SyncOp => ({
  kind: 'delete',
  sessionId,
  exerciseIndex: 0,
  setIndex,
});

const apiError = (status: number, code = `HTTP_${status}`): Error =>
  Object.assign(new Error(code), { name: 'ApiError', status, code });

/** A send whose calls resolve only when the test says so. */
function gatedSend() {
  const calls: { op: SyncOp; resolve: () => void; reject: (e: unknown) => void }[] = [];
  const send = vi.fn(
    (op: SyncOp) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ op, resolve, reject });
      }),
  );
  return { send, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('enqueue', () => {
  it('keeps one op per set: the newest intent replaces the older one and goes to the back', () => {
    let ops: SyncOp[] = [];
    ops = enqueue(ops, put(0, 80));
    ops = enqueue(ops, put(1, 80));
    ops = enqueue(ops, put(0, 82.5));
    expect(ops).toEqual([put(1, 80), put(0, 82.5)]);
  });

  it('turns a tick then an untick into one delete — PUT and DELETE are idempotent by key', () => {
    expect(enqueue([put(0, 80)], del(0))).toEqual([del(0)]);
  });

  it('never mixes up two sessions that share set numbers', () => {
    const ops = enqueue([put(0, 80, 10, 's1')], put(0, 90, 10, 's2'));
    expect(ops).toHaveLength(2);
    expect(opKey(ops[0]!)).toBe('s1/0/0');
  });
});

describe('parseQueue', () => {
  it('reads what was stored and skips anything that is not an op', () => {
    const raw = JSON.stringify([put(0, 80), { kind: 'put' }, 'junk', del(1)]);
    expect(parseQueue(raw)).toEqual([put(0, 80), del(1)]);
  });

  it('is empty for nothing stored or unreadable JSON', () => {
    expect(parseQueue(null)).toEqual([]);
    expect(parseQueue('{not json')).toEqual([]);
    expect(parseQueue('{"a":1}')).toEqual([]);
  });
});

describe('classifyFailure', () => {
  it('drops what can never succeed: a missing, finished or invalid set', () => {
    for (const status of [400, 404, 409, 410, 422]) {
      expect(classifyFailure(apiError(status))).toBe('drop');
    }
  });

  it('retries everything else — no signal, a signed-out session, a busy or broken server', () => {
    expect(classifyFailure(new TypeError('Failed to fetch'))).toBe('retry');
    for (const status of [401, 403, 408, 429, 500, 502, 503]) {
      expect(classifyFailure(apiError(status))).toBe('retry');
    }
    expect(classifyFailure('weird')).toBe('retry');
  });
});

describe('createSyncQueue', () => {
  it('persists every change, in order, so a reload replays them', () => {
    const storage = memoryStorage();
    const queue = createSyncQueue({ storage, send: vi.fn() });
    queue.add(put(0, 80));
    queue.add(put(1, 80));
    expect(parseQueue(storage.read())).toEqual([put(0, 80), put(1, 80)]);

    const reloaded = createSyncQueue({ storage, send: vi.fn() });
    expect(reloaded.snapshot().ops).toEqual([put(0, 80), put(1, 80)]);
  });

  it('sends in order and forgets each op once the server has it', async () => {
    const storage = memoryStorage();
    const sent: SyncOp[] = [];
    const queue = createSyncQueue({
      storage,
      send: async (op) => {
        sent.push(op);
      },
    });
    queue.add(put(0, 80));
    queue.add(del(1));
    const result = await queue.flush();
    expect(sent).toEqual([put(0, 80), del(1)]);
    expect(result).toEqual({
      sent: 2,
      dropped: 0,
      stalled: false,
      resync: false,
      resyncSessions: [],
    });
    expect(queue.snapshot().ops).toEqual([]);
    expect(parseQueue(storage.read())).toEqual([]);
  });

  it('stops at the first op the network loses, keeps it and everything after it', async () => {
    const send = vi
      .fn<(op: SyncOp) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const queue = createSyncQueue({ storage: memoryStorage(), send });
    queue.add(put(0, 80));
    queue.add(put(1, 80));
    queue.add(put(2, 80));

    const first = await queue.flush();
    expect(first).toEqual({
      sent: 1,
      dropped: 0,
      stalled: true,
      resync: false,
      resyncSessions: [],
    });
    expect(queue.snapshot()).toMatchObject({ ops: [put(1, 80), put(2, 80)], stalled: true });

    send.mockResolvedValue(undefined);
    const second = await queue.flush();
    expect(second.sent).toBe(2);
    expect(queue.snapshot()).toMatchObject({ ops: [], stalled: false });
  });

  it('drops an op the server refuses for good (404/409), carries on, and asks for a resync', async () => {
    const send = vi
      .fn<(op: SyncOp) => Promise<void>>()
      .mockRejectedValueOnce(apiError(409, 'WORKOUT_SESSION_FINISHED'))
      .mockResolvedValueOnce(undefined);
    const queue = createSyncQueue({ storage: memoryStorage(), send });
    queue.add(put(0, 80));
    queue.add(put(1, 80));
    const result = await queue.flush();
    expect(result).toEqual({
      sent: 1,
      dropped: 1,
      stalled: false,
      resync: true,
      resyncSessions: ['s1'],
    });
    expect(queue.snapshot().ops).toEqual([]);
  });

  it('names only the sessions that lost an op, so an old one does not disturb the open one', async () => {
    const send = vi
      .fn<(op: SyncOp) => Promise<void>>()
      .mockRejectedValueOnce(apiError(409, 'WORKOUT_SESSION_FINISHED'))
      .mockResolvedValueOnce(undefined);
    const queue = createSyncQueue({ storage: memoryStorage(), send });
    queue.add(put(0, 60, 10, 'old'));
    queue.add(put(0, 80, 10, 's1'));
    const result = await queue.flush();
    expect(result.resyncSessions).toEqual(['old']);
  });

  it('runs one flush at a time — a second call shares the first', async () => {
    const { send, calls } = gatedSend();
    const queue = createSyncQueue({ storage: memoryStorage(), send });
    queue.add(put(0, 80));
    const a = queue.flush();
    const b = queue.flush();
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.snapshot().flushing).toBe(true);
    calls[0]!.resolve();
    expect(await a).toEqual(await b);
    expect(queue.snapshot().flushing).toBe(false);
  });

  it('sends a newer edit that arrives while the older one is in flight, after it', async () => {
    const { send, calls } = gatedSend();
    const queue = createSyncQueue({ storage: memoryStorage(), send });
    queue.add(put(0, 80));
    const flushing = queue.flush();
    await tick();
    queue.add(put(0, 82.5)); // replaces the queued copy of the in-flight op
    calls[0]!.resolve();
    await tick();
    expect(calls[1]?.op).toEqual(put(0, 82.5));
    calls[1]!.resolve();
    const result = await flushing;
    expect(result.sent).toBe(2);
    expect(queue.snapshot().ops).toEqual([]);
  });

  it('counts and clears one session without touching another', () => {
    const queue = createSyncQueue({ storage: memoryStorage(), send: vi.fn() });
    queue.add(put(0, 80, 10, 's1'));
    queue.add(put(1, 80, 10, 's1'));
    queue.add(put(0, 60, 10, 'old'));
    expect(queue.pending('s1')).toBe(2);
    expect(queue.opsFor('old')).toEqual([put(0, 60, 10, 'old')]);
    queue.clear('s1');
    expect(queue.snapshot().ops).toEqual([put(0, 60, 10, 'old')]);
  });

  it('tells its listener about every change', async () => {
    const onChange = vi.fn();
    const queue = createSyncQueue({ storage: memoryStorage(), send: async () => {}, onChange });
    queue.add(put(0, 80));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ ops: [put(0, 80)], flushing: false }),
    );
    await queue.flush();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ ops: [], flushing: false, stalled: false }),
    );
  });
});

describe('browserStorage', () => {
  it('reads and writes localStorage under the queue key', () => {
    window.localStorage.clear();
    const storage = browserStorage();
    storage.write('[]');
    expect(window.localStorage.getItem(SYNC_STORAGE_KEY)).toBe('[]');
    expect(storage.read()).toBe('[]');
  });
});

describe('syncLine', () => {
  it('promises the sets are safe while there is nothing waiting', () => {
    expect(syncLine({ pending: 0, flushing: false, offline: false })).toEqual({
      tone: 'ok',
      text: 'Every set saves as you tick it — even with no signal.',
    });
    expect(syncLine({ pending: 0, flushing: false, offline: true }).tone).toBe('ok');
  });

  it('says "Saving…" while it sends, and counts what waits for signal', () => {
    expect(syncLine({ pending: 2, flushing: true, offline: false })).toEqual({
      tone: 'busy',
      text: 'Saving…',
    });
    expect(syncLine({ pending: 3, flushing: false, offline: true })).toEqual({
      tone: 'warn',
      text: 'Offline — 3 sets waiting',
    });
    expect(syncLine({ pending: 1, flushing: true, offline: true }).text).toBe(
      'Offline — 1 set waiting',
    );
  });
});
