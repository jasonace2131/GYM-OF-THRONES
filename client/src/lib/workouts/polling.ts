import type { WorkoutDraftStatus } from '@got/shared';

/**
 * How `/portal/workouts/draft` watches a generation.
 *
 * The draft IS the job (spec §3): `GET /me/workouts/draft` is read every
 * 800 ms until it is READY or FAILED, or gone (404 — cancelled from another
 * tab, or saved), or 90 s have passed, which is when the server itself
 * FAILS a stale draft. Pure decision + an injectable loop, so the schedule is
 * tested without timers.
 */

export const POLL_INTERVAL_MS = 800;
export const POLL_MAX_MS = 90_000;

export type StopReason = 'READY' | 'FAILED' | 'MISSING' | 'TIMEOUT' | 'CANCELLED';

export type PollDecision =
  | { kind: 'continue'; delayMs: number }
  | { kind: 'stop'; reason: Exclude<StopReason, 'CANCELLED'> };

export type PollOutcome = { status: WorkoutDraftStatus } | { missing: true };

export function nextPoll(outcome: PollOutcome, elapsedMs: number): PollDecision {
  if ('missing' in outcome) return { kind: 'stop', reason: 'MISSING' };
  if (outcome.status === 'READY') return { kind: 'stop', reason: 'READY' };
  if (outcome.status === 'FAILED') return { kind: 'stop', reason: 'FAILED' };
  if (elapsedMs >= POLL_MAX_MS) return { kind: 'stop', reason: 'TIMEOUT' };
  return { kind: 'continue', delayMs: POLL_INTERVAL_MS };
}

interface PollDeps<T extends { status: WorkoutDraftStatus }> {
  fetchDraft: () => Promise<T>;
  /** Every draft read, in order — the screen paints days as they land. */
  onDraft: (draft: T) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  isCancelled?: () => boolean;
}

export interface PollResult<T> {
  reason: StopReason;
  draft: T | null;
}

function isNotFound(caught: unknown): boolean {
  return (
    caught instanceof Error &&
    caught.name === 'ApiError' &&
    (caught as { status?: unknown }).status === 404
  );
}

/**
 * Runs the schedule. A 404 ends it as MISSING; any other read failure (a
 * network blip) is retried on the next tick rather than abandoning a draft
 * the server is still writing.
 */
export async function pollDraft<T extends { status: WorkoutDraftStatus }>(
  deps: PollDeps<T>,
): Promise<PollResult<T>> {
  const started = deps.now();
  let last: T | null = null;

  for (;;) {
    let outcome: PollOutcome;
    try {
      last = await deps.fetchDraft();
      deps.onDraft(last);
      outcome = { status: last.status };
    } catch (caught) {
      if (isNotFound(caught)) return { reason: 'MISSING', draft: null };
      outcome = { status: 'RUNNING' };
    }

    if (deps.isCancelled?.()) return { reason: 'CANCELLED', draft: last };

    const decision = nextPoll(outcome, deps.now() - started);
    if (decision.kind === 'stop') return { reason: decision.reason, draft: last };
    await deps.sleep(decision.delayMs);
    if (deps.isCancelled?.()) return { reason: 'CANCELLED', draft: last };
  }
}

/** The browser's sleep, for the page; tests inject their own. */
export const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
