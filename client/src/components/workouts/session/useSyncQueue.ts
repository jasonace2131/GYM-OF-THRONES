'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { workoutsApi } from '@/lib/workouts/api';
import {
  browserStorage,
  createSyncQueue,
  syncLine,
  type FlushResult,
  type QueueSnapshot,
  type SyncOp,
  type SyncQueue,
} from '@/lib/workouts/syncQueue';

/**
 * The one sync queue of this tab, and the hook the session screen drives it
 * with. The rules live in `lib/workouts/syncQueue.ts`; this only decides WHEN
 * to replay: after every tick, when the phone comes back `online`, and every
 * 10 s while anything waits.
 */

const RETRY_MS = 10_000;

const EMPTY: QueueSnapshot = { ops: [], flushing: false, stalled: false };

let shared: SyncQueue | null = null;
/** The last snapshot, kept by reference so `useSyncExternalStore` sees a stable value. */
let latest: QueueSnapshot = EMPTY;
const listeners = new Set<() => void>();

/** Created on first use in the browser — never during a server render. */
export function sharedSyncQueue(): SyncQueue {
  if (shared === null) {
    shared = createSyncQueue({
      storage: browserStorage(),
      send: workoutsApi.sendOp,
      onChange: (snapshot) => {
        latest = snapshot;
        listeners.forEach((listener) => listener());
      },
    });
    latest = shared.snapshot();
  }
  return shared;
}

function subscribeQueue(listener: () => void): () => void {
  sharedSyncQueue();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

export function useSyncQueue(sessionId: string | null, onResync: () => void) {
  const snapshot = useSyncExternalStore(
    subscribeQueue,
    () => latest,
    () => EMPTY,
  );
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );

  const resync = useRef(onResync);
  const openId = useRef(sessionId);
  useEffect(() => {
    resync.current = onResync;
    openId.current = sessionId;
  }, [onResync, sessionId]);

  const flush = useCallback(async (): Promise<FlushResult> => {
    const result = await sharedSyncQueue().flush();
    // Only a set of THIS workout the server refused means the screen is wrong.
    if (openId.current !== null && result.resyncSessions.includes(openId.current)) {
      resync.current();
    }
    return result;
  }, []);

  // Replay on the way in, whenever the signal returns, and every 10 s while anything waits.
  useEffect(() => {
    const replay = (): void => {
      void flush();
    };
    window.addEventListener('online', replay);
    const timer = window.setInterval(() => {
      if (sharedSyncQueue().snapshot().ops.length > 0) replay();
    }, RETRY_MS);
    replay();
    return () => {
      window.removeEventListener('online', replay);
      window.clearInterval(timer);
    };
  }, [flush]);

  const add = useCallback(
    (op: SyncOp | null): void => {
      if (op === null) return;
      sharedSyncQueue().add(op);
      void flush();
    },
    [flush],
  );

  const pending =
    sessionId === null ? 0 : snapshot.ops.filter((op) => op.sessionId === sessionId).length;

  return {
    add,
    flush,
    pending,
    line: syncLine({
      pending,
      flushing: snapshot.flushing,
      offline: !online || snapshot.stalled,
    }),
  };
}
