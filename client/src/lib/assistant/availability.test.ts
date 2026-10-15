import { describe, expect, it } from 'vitest';
import { availabilityCopy, availabilityFromError, availabilityFromStatus } from './availability';

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

describe('assistant availability', () => {
  it('reads the status route', () => {
    expect(availabilityFromStatus({ enabled: true })).toBe('on');
    expect(availabilityFromStatus({ enabled: false })).toBe('off');
  });

  /**
   * THE BUG. `GET /me/assistant/status` is gated on `ai.chat.use`, so a caller
   * without it gets a 403 — and the page turned every failure into
   * `enabled: false` and told them the assistant "is not switched on". It was
   * on; they could not use it.
   */
  it('tells a 403 apart from "switched off"', () => {
    expect(availabilityFromError(new FakeApiError('Forbidden', 403, 'HTTP_403'))).toBe(
      'forbidden',
    );
  });

  it('calls anything else a failure to reach it, not "switched off"', () => {
    expect(availabilityFromError(new FakeApiError('Oops', 500, 'HTTP_500'))).toBe('unreachable');
    expect(availabilityFromError(new TypeError('Failed to fetch'))).toBe('unreachable');
  });

  it('says something different for each state', () => {
    const titles = (['off', 'forbidden', 'unreachable'] as const).map(
      (state) => availabilityCopy(state).title,
    );
    expect(new Set(titles).size).toBe(3);
    expect(availabilityCopy('off').title).toMatch(/not switched on/i);
    expect(availabilityCopy('forbidden').title).not.toMatch(/switched on/i);
    expect(availabilityCopy('unreachable').retry).toBe(true);
    expect(availabilityCopy('off').retry).toBe(false);
  });
});
