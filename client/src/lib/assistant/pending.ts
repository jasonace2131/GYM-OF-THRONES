/**
 * How long the portal waits, and what it says while it does.
 *
 * 40 s is deliberately LONGER than the server's own 25 s budget
 * (server/src/assistant/assistant-budget.ts). When an answer runs long, the
 * server gives up first and says why — "ask for a shorter plan" — which is far
 * more useful than the browser's own timeout, which can only say that nothing
 * came back.
 */
export const ASSISTANT_CLIENT_TIMEOUT_MS = 40_000;

const PLAN_LIKE = /plan|program|routine|schedule|week/i;

/**
 * The line under a pending question, re-read every second.
 *
 * A one-line answer arrives in a second or two and never gets past
 * "Thinking…". A weekly plan can take half a minute on the free tier, and a
 * spinner that says nothing for thirty seconds reads as broken — so after
 * three seconds it says what is happening, and after twenty that it is
 * nearly done.
 */
export function pendingLabel(question: string, elapsedMs: number): string {
  if (elapsedMs >= 20_000) return 'Almost there — long plans take the longest.';
  if (elapsedMs >= 3_000) {
    return PLAN_LIKE.test(question)
      ? 'Writing your plan… this can take up to 30 seconds.'
      : 'Still working on it…';
  }
  return 'Thinking…';
}

/**
 * `AbortSignal.timeout(ASSISTANT_CLIENT_TIMEOUT_MS)`, or undefined where the
 * browser has no `AbortSignal.timeout` (Safari before 16). A missing timeout
 * must never stop the question from being sent at all.
 */
export function assistantTimeoutSignal(
  ms: number = ASSISTANT_CLIENT_TIMEOUT_MS,
): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}
