import {
  ASK_BUDGET_MS,
  BudgetExhaustedError,
  MIN_ATTEMPT_MS,
  canStartAttempt,
  remainingMs,
} from './assistant-budget';
import { isTimeout } from './gemini-models';

describe('the assistant time budget', () => {
  /**
   * 25 s, not the old 12 s: a full weekly plan from a free-tier model takes
   * longer than a one-line answer, and 12 s was never enforced anyway — it was
   * only checked BEFORE each attempt, so a running call could take as long as
   * the platform allowed. The portal's own timeout (40 s) must stay above
   * this, so the server's message arrives before the browser gives up.
   */
  it('is 25 seconds, with 4 seconds as the least worth starting an attempt on', () => {
    expect(ASK_BUDGET_MS).toBe(25_000);
    expect(MIN_ATTEMPT_MS).toBe(4_000);
    expect(ASK_BUDGET_MS).toBeLessThan(40_000);
  });

  describe('remainingMs', () => {
    it('is the time left until the deadline', () => {
      expect(remainingMs(10_000, 4_000)).toBe(6_000);
    });

    it('never goes negative — a per-call timeout of -1 would mean "no timeout"', () => {
      // The SDK arms its abort only when `timeout >= 0`.
      expect(remainingMs(10_000, 12_000)).toBe(0);
    });

    it('reads the clock when no instant is given', () => {
      const deadline = Date.now() + 5_000;
      const left = remainingMs(deadline);
      expect(left).toBeGreaterThan(4_000);
      expect(left).toBeLessThanOrEqual(5_000);
    });
  });

  describe('canStartAttempt', () => {
    it('allows an attempt with at least MIN_ATTEMPT_MS left', () => {
      expect(canStartAttempt(10_000, 10_000 - MIN_ATTEMPT_MS)).toBe(true);
      expect(canStartAttempt(10_000, 0)).toBe(true);
    });

    it('refuses one with less — it would only time out and waste a quota call', () => {
      expect(canStartAttempt(10_000, 10_000 - MIN_ATTEMPT_MS + 1)).toBe(false);
      expect(canStartAttempt(10_000, 20_000)).toBe(false);
    });
  });

  describe('BudgetExhaustedError', () => {
    it('is classified as a timeout, so it ends the ask instead of rotating', () => {
      const error = new BudgetExhaustedError('no time left for tool round 2');
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('TimeoutError');
      expect(isTimeout(error)).toBe(true);
    });
  });
});
