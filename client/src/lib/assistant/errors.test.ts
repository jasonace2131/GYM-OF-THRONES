import { describe, expect, it, vi } from 'vitest';

// api.ts imports the Supabase client, which throws without env vars. The
// real ApiError class is still what these tests use.
vi.mock('../supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));

import { ApiError } from '../api';
import { assistantErrorMessage } from './errors';

const DROPPED =
  'The connection dropped while the answer was being written. Try again — shorter requests are faster.';

describe('assistantErrorMessage', () => {
  it.each([
    [
      'ASSISTANT_TIMEOUT',
      'That answer took too long to write. Try again, or ask for a shorter plan — just the school days, for example.',
    ],
    ['ASSISTANT_BUSY', 'The assistant is busy right now. Please try again in a minute.'],
    [
      'ASSISTANT_NOT_CONFIGURED',
      'The assistant is switched off right now — the front desk can help.',
    ],
  ])("shows the server's own words for %s", (code, message) => {
    expect(assistantErrorMessage(new ApiError(message, 503, code))).toBe(message);
  });

  /**
   * The server that is live today predates the named codes and sends a bare
   * HTTP_503 with "busy" in it. That is still a better sentence than the one
   * this screen used to replace it with.
   */
  it('shows the message of a legacy HTTP_503 too', () => {
    const legacy = new ApiError(
      'The assistant is busy right now. Please try again in a minute.',
      503,
      'HTTP_503',
    );
    expect(assistantErrorMessage(legacy)).toBe(
      'The assistant is busy right now. Please try again in a minute.',
    );
  });

  it.each([
    ['a proxy page instead of JSON', new ApiError('non-JSON', 504, 'INVALID_RESPONSE')],
    ['a 502', new ApiError('Bad gateway', 502, 'HTTP_502')],
    ['a 504', new ApiError('Gateway timeout', 504, 'HTTP_504')],
    ['a 200 whose body was cut off', new ApiError('non-JSON', 200, 'INVALID_RESPONSE')],
  ])('calls %s a dropped connection', (_label, error) => {
    expect(assistantErrorMessage(error)).toBe(DROPPED);
  });

  it('keeps the rate-limit copy for a 429', () => {
    expect(assistantErrorMessage(new ApiError('Too Many Requests', 429, 'HTTP_429'))).toBe(
      'That is a lot of questions at once. Give it a minute.',
    );
  });

  it('never shows "Internal server error" in a chat bubble', () => {
    expect(
      assistantErrorMessage(new ApiError('Internal server error', 500, 'INTERNAL_SERVER_ERROR')),
    ).toBe('That one did not go through. Try asking again.');
  });

  it("keeps the server's message for any other refusal, as the screen always has", () => {
    expect(assistantErrorMessage(new ApiError('Forbidden resource', 403, 'HTTP_403'))).toBe(
      'Forbidden resource',
    );
  });

  it('says 40 seconds passed when the browser gave up waiting', () => {
    expect(assistantErrorMessage(new DOMException('signal timed out', 'TimeoutError'))).toMatch(
      /^No answer after 40 seconds/,
    );
  });

  it('treats a network failure as being offline', () => {
    expect(assistantErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'You look to be offline. Check your connection and try again.',
    );
  });

  it.each([[new Error('boom')], ['a string'], [null], [undefined]])(
    'falls back to a generic line for %s',
    (caught) => {
      expect(assistantErrorMessage(caught)).toBe('Something went wrong. Try asking again.');
    },
  );
});
