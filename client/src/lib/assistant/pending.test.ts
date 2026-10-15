import { afterEach, describe, expect, it } from 'vitest';
import { ASSISTANT_CLIENT_TIMEOUT_MS, assistantTimeoutSignal, pendingLabel } from './pending';

describe('ASSISTANT_CLIENT_TIMEOUT_MS', () => {
  it("is 40 s — longer than the server's 25 s budget, so the server's reason arrives first", () => {
    expect(ASSISTANT_CLIENT_TIMEOUT_MS).toBe(40_000);
    expect(ASSISTANT_CLIENT_TIMEOUT_MS).toBeGreaterThan(25_000);
  });
});

describe('pendingLabel', () => {
  const PLAN = 'can you make me a workout plan? I have school on monday';

  it('says "Thinking…" for the first three seconds of anything', () => {
    expect(pendingLabel(PLAN, 0)).toBe('Thinking…');
    expect(pendingLabel('What time do you open?', 2_999)).toBe('Thinking…');
  });

  it.each(['make me a plan', 'a 3-day program', 'a morning routine', 'my schedule', 'this WEEK'])(
    'warns that a plan-like question (%s) takes longer',
    (question) => {
      expect(pendingLabel(question, 3_000)).toBe(
        'Writing your plan… this can take up to 30 seconds.',
      );
    },
  );

  it('says it is still working on anything else', () => {
    expect(pendingLabel('How do I do a deadlift?', 3_000)).toBe('Still working on it…');
    expect(pendingLabel('How do I do a deadlift?', 19_999)).toBe('Still working on it…');
  });

  it('says it is almost there after 20 seconds', () => {
    expect(pendingLabel(PLAN, 20_000)).toBe('Almost there — long plans take the longest.');
    expect(pendingLabel('How do I do a deadlift?', 35_000)).toBe(
      'Almost there — long plans take the longest.',
    );
  });
});

describe('assistantTimeoutSignal', () => {
  const original = AbortSignal.timeout;

  afterEach(() => {
    AbortSignal.timeout = original;
  });

  it('is a signal that aborts after the client timeout', () => {
    const signal = assistantTimeoutSignal();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it('is undefined — never a throw — where AbortSignal.timeout does not exist', () => {
    // Safari before 16. A missing timeout must not stop the question being sent.
    (AbortSignal as unknown as { timeout: unknown }).timeout = undefined;
    expect(assistantTimeoutSignal()).toBeUndefined();
  });
});
