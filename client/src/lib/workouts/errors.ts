/**
 * What the planner says when a call fails — the same discipline as
 * `lib/assistant/errors.ts`: the server's words whenever it named the
 * failure (WORKOUT_* and ASSISTANT_* are member copy by design, spec §7),
 * and this screen's own line only for failures the server never saw.
 */

const DROPPED = 'The connection dropped part-way. Try again.';
const RATE_LIMITED = 'That is a lot at once. Give it a minute and try again.';
const SERVER_FAULT = 'That one did not go through. Try again.';
const OFFLINE = 'You look to be offline. Check your connection and try again.';
const GENERIC = 'Something went wrong. Try again.';

interface ApiErrorLike {
  message: string;
  status: number;
  code: string;
  details?: unknown;
}

/**
 * Structural, not `instanceof ApiError`: importing lib/api would pull the
 * Supabase client into this module and make it untestable on its own.
 */
export function isApiError(caught: unknown): caught is ApiErrorLike {
  return (
    caught instanceof Error &&
    caught.name === 'ApiError' &&
    typeof (caught as { status?: unknown }).status === 'number' &&
    typeof (caught as { code?: unknown }).code === 'string'
  );
}

export function workoutErrorMessage(caught: unknown): string {
  if (isApiError(caught)) {
    if (caught.code.startsWith('WORKOUT_') || caught.code.startsWith('ASSISTANT_')) {
      return caught.message;
    }
    if (caught.code === 'INVALID_RESPONSE' || caught.status === 502 || caught.status === 504) {
      return DROPPED;
    }
    if (caught.status === 429) return RATE_LIMITED;
    if (caught.status >= 500) return SERVER_FAULT;
    return caught.message;
  }
  if (caught instanceof TypeError) return OFFLINE;
  return GENERIC;
}

/** The daily budget is spent: show the reset time inline, never a toast. */
export function isQuotaExhausted(caught: unknown): boolean {
  return isApiError(caught) && caught.code === 'WORKOUT_AI_LIMIT';
}

/** No draft: cancelled elsewhere, saved already, or never started. */
export function isDraftMissing(caught: unknown): boolean {
  return isApiError(caught) && caught.status === 404;
}

// ── Workout sessions (feat/workout-sessions) ──────────────────────────────

/**
 * 409 WORKOUT_SESSION_OPEN on Start: another workout is open. `details.sessionId`
 * names it; null when the server did not say (the screen can still Continue it
 * through `sessions/current`). Null for any other failure.
 */
export function openSessionConflict(caught: unknown): { sessionId: string | null } | null {
  if (!isApiError(caught) || caught.code !== 'WORKOUT_SESSION_OPEN') return null;
  const details = caught.details as { sessionId?: unknown } | null | undefined;
  const id = details?.sessionId;
  return { sessionId: typeof id === 'string' && id !== '' ? id : null };
}

/** 422: nothing is ticked, so there is nothing to finish — discard instead. */
export function isSessionEmpty(caught: unknown): boolean {
  return isApiError(caught) && caught.code === 'WORKOUT_SESSION_EMPTY';
}

/** 404: the workout was discarded (or never was this member's). */
export function isSessionGone(caught: unknown): boolean {
  return isApiError(caught) && caught.status === 404;
}

/** `fetch` itself failed — no signal. */
export function isOffline(caught: unknown): boolean {
  return caught instanceof TypeError;
}
