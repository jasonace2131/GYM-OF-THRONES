/**
 * The time one question may take, end to end, across every model it tries.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OLD 12-SECOND "DEADLINE" WAS NEVER A BOUND.
 *
 * It was checked only BEFORE each model attempt, and no Gemini call carried a
 * timeout at all — so an attempt that started at 11.9 s could run for as long
 * as Google or the platform's proxy allowed. It also sat far below what a full
 * weekly workout plan takes to write on a free-tier model.
 *
 * Now every Gemini call — the first message AND every tool round — is sent
 * with `timeout = remainingMs(deadline)`, so the SDK aborts it when the budget
 * runs out, wherever in the ask that happens. There is deliberately no
 * separate per-call cap: fast failures (404, 429, 5xx) return in well under a
 * second and still rotate quickly, and a cap would only cut short the slow
 * SUCCESS a long plan legitimately is.
 *
 * 25 s leaves room under the portal's own 40 s timeout, so the member reads
 * the server's explanation rather than the browser's.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const ASK_BUDGET_MS = 25_000;

/**
 * Below this, a new model attempt is not started. A one-line answer takes one
 * to three seconds; an attempt begun with less than four left would mostly
 * time out, and on the free tier a timed-out call still spends quota.
 */
export const MIN_ATTEMPT_MS = 4_000;

/** Milliseconds left before `deadline`, never negative. */
export function remainingMs(deadline: number, now: number = Date.now()): number {
  return Math.max(0, deadline - now);
}

export function canStartAttempt(deadline: number, now: number = Date.now()): boolean {
  return remainingMs(deadline, now) >= MIN_ATTEMPT_MS;
}

/**
 * Thrown when the budget is spent between tool rounds, before a call is made.
 *
 * Named `TimeoutError` — the same name the platform's `AbortSignal.timeout`
 * uses — so `isTimeout()` treats it exactly like an aborted Gemini call: the
 * ask ends with ASSISTANT_TIMEOUT and no further model is tried.
 */
export class BudgetExhaustedError extends Error {
  override readonly name = 'TimeoutError';
}
