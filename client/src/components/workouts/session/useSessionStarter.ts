'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { StartSessionBody } from '@got/shared';
import { workoutsApi } from '@/lib/workouts/api';
import { isSessionGone, openSessionConflict, workoutErrorMessage } from '@/lib/workouts/errors';
import { clearSessionCache, writeSessionCache } from '@/lib/workouts/sessionCache';
import { SESSION_HREF } from '@/lib/workouts/today';
import { startKey } from '@/lib/workouts/todaySource';
import { sharedSyncQueue } from './useSyncQueue';

export type StarterState =
  | { kind: 'idle' }
  | { kind: 'starting'; key: string }
  | { kind: 'conflict'; key: string; body: StartSessionBody; openId: string | null }
  | { kind: 'error'; key: string; message: string };

/**
 * "Start" / "Start this day" anywhere: `POST /me/workouts/sessions`, then the
 * session screen. One workout may be open at a time, so a 409
 * WORKOUT_SESSION_OPEN becomes an inline choice beside the button that was
 * pressed (spec §5) — Continue it, or Discard it and start this one.
 */
export function useSessionStarter() {
  const router = useRouter();
  const [state, setState] = useState<StarterState>({ kind: 'idle' });

  const start = useCallback(
    async (body: StartSessionBody): Promise<void> => {
      const key = startKey(body);
      setState({ kind: 'starting', key });
      try {
        const view = await workoutsApi.startSession(body);
        // The session screen paints from this at once, and can open it offline.
        writeSessionCache({ view, current: 0, rest: null });
        router.push(SESSION_HREF);
      } catch (caught) {
        const conflict = openSessionConflict(caught);
        setState(
          conflict === null
            ? { kind: 'error', key, message: workoutErrorMessage(caught) }
            : { kind: 'conflict', key, body, openId: conflict.sessionId },
        );
      }
    },
    [router],
  );

  const continueOpen = useCallback((): void => {
    router.push(SESSION_HREF);
  }, [router]);

  const discardAndStart = useCallback(async (): Promise<void> => {
    if (state.kind !== 'conflict') return;
    const { body, key } = state;
    setState({ kind: 'starting', key });
    try {
      const openId = state.openId ?? (await workoutsApi.currentSession()).session?.id ?? null;
      if (openId !== null) {
        await workoutsApi.discardSession(openId).catch((caught: unknown) => {
          if (!isSessionGone(caught)) throw caught;
        });
        sharedSyncQueue().clear(openId);
      }
      clearSessionCache();
    } catch (caught) {
      setState({ kind: 'error', key, message: workoutErrorMessage(caught) });
      return;
    }
    await start(body);
  }, [start, state]);

  const dismiss = useCallback((): void => setState({ kind: 'idle' }), []);

  return { state, start, continueOpen, discardAndStart, dismiss };
}

export type SessionStarter = ReturnType<typeof useSessionStarter>;
