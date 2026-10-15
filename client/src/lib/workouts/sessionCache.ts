import type { WorkoutSessionSummary, WorkoutSessionView } from '@got/shared';
import type { RestState } from './restTimer';

/**
 * The open session, kept on the phone (spec §5 "Offline").
 *
 * The session screen writes its view — with every set ticked on this phone
 * in it — after each change, so that a reload in a basement with no signal
 * still opens the workout, on the same exercise, with the rest still running.
 * The server stays the truth whenever it answers; this is only the fallback.
 *
 * Registered in `MEMBER_DEVICE_CACHE_KEYS`: sign-out clears it.
 */

export const SESSION_CACHE_KEY = 'got.workouts.session.v1';

export interface CachedSession {
  view: WorkoutSessionView;
  current: number;
  rest: RestState | null;
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function local(): KeyValue | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isView(value: unknown): value is WorkoutSessionView {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['dayTitle'] === 'string' &&
    typeof v['startedAt'] === 'string' &&
    Array.isArray(v['exercises']) &&
    v['exercises'].length > 0 &&
    Array.isArray(v['sets'])
  );
}

function isRest(value: unknown): value is RestState {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['endsAt'] === 'number' &&
    typeof v['exerciseIndex'] === 'number' &&
    typeof v['nextSet'] === 'number'
  );
}

export function readSessionCache(storage: KeyValue | null = local()): CachedSession | null {
  try {
    const raw = storage?.getItem(SESSION_CACHE_KEY) ?? null;
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isView(parsed['view'])) return null;
    const current = parsed['current'];
    return {
      view: parsed['view'],
      current: typeof current === 'number' && Number.isInteger(current) ? current : 0,
      rest: isRest(parsed['rest']) ? parsed['rest'] : null,
    };
  } catch {
    return null;
  }
}

export function writeSessionCache(value: CachedSession, storage: KeyValue | null = local()): void {
  try {
    storage?.setItem(SESSION_CACHE_KEY, JSON.stringify(value));
  } catch {
    // Private mode or a full disk: the workout still runs, it just will not survive a reload.
  }
}

export function clearSessionCache(storage: KeyValue | null = local()): void {
  try {
    storage?.removeItem(SESSION_CACHE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Finish → summary, in the same tab: the finish call already returned the
 * summary, so the "Workout done" screen paints at once instead of reading it
 * again. Memory only — a reload reads it from the server like any history row.
 */
let lastSummary: WorkoutSessionSummary | null = null;

export function stashSummary(summary: WorkoutSessionSummary): void {
  lastSummary = summary;
}

export function stashedSummary(id: string): WorkoutSessionSummary | null {
  return lastSummary !== null && lastSummary.id === id ? lastSummary : null;
}
