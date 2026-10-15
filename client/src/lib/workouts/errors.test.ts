import { describe, expect, it, vi } from 'vitest';

// api.ts imports the Supabase client, which throws without env vars. The
// real ApiError class is still what these tests use.
vi.mock('../supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));

import { ApiError } from '../api';
import {
  isDraftMissing,
  isOffline,
  isQuotaExhausted,
  isSessionEmpty,
  isSessionGone,
  openSessionConflict,
  workoutErrorMessage,
} from './errors';

describe('workout session errors', () => {
  it('reads the open workout from a 409 WORKOUT_SESSION_OPEN', () => {
    const open = new ApiError('A workout is already open.', 409, 'WORKOUT_SESSION_OPEN', {
      sessionId: 'sess-1',
    });
    expect(openSessionConflict(open)).toEqual({ sessionId: 'sess-1' });
    expect(
      openSessionConflict(new ApiError('A workout is already open.', 409, 'WORKOUT_SESSION_OPEN')),
    ).toEqual({ sessionId: null });
    expect(openSessionConflict(new ApiError('x', 409, 'WORKOUT_DRAFT_RUNNING'))).toBeNull();
    expect(openSessionConflict(new TypeError('Failed to fetch'))).toBeNull();
  });

  it('knows an empty finish, a missing session and no signal', () => {
    expect(isSessionEmpty(new ApiError('Tick a set first.', 422, 'WORKOUT_SESSION_EMPTY'))).toBe(
      true,
    );
    expect(isSessionEmpty(new ApiError('x', 404, 'WORKOUT_SESSION_MISSING'))).toBe(false);
    expect(isSessionGone(new ApiError('x', 404, 'WORKOUT_SESSION_MISSING'))).toBe(true);
    expect(isSessionGone(new ApiError('x', 409, 'WORKOUT_SESSION_FINISHED'))).toBe(false);
    expect(isOffline(new TypeError('Failed to fetch'))).toBe(true);
    expect(isOffline(new ApiError('x', 500, 'INTERNAL_SERVER_ERROR'))).toBe(false);
  });
});

describe('workoutErrorMessage', () => {
  it.each([
    ['WORKOUT_AI_LIMIT', 429, 'You have used all 8 AI actions for today.'],
    ['WORKOUT_DRAFT_RUNNING', 409, 'A plan is already being written.'],
    ['WORKOUT_PLAN_LIMIT', 409, 'You already keep 5 plans. Delete one first.'],
    ['WORKOUT_PLAN_INVALID', 400, 'days[0].title must be 1-40 characters.'],
    ['WORKOUT_CONSENT_REQUIRED', 400, 'Tick the consent box first.'],
    ['ASSISTANT_BUSY', 503, 'The assistant is busy right now. Please try again in a minute.'],
    ['ASSISTANT_TIMEOUT', 503, 'That took too long. Try again.'],
  ])("shows the server's own words for %s", (code, status, message) => {
    expect(workoutErrorMessage(new ApiError(message, status, code))).toBe(message);
  });

  it('writes its own line for failures the server never named', () => {
    expect(workoutErrorMessage(new ApiError('Too Many Requests', 429, 'HTTP_429'))).toBe(
      'That is a lot at once. Give it a minute and try again.',
    );
    expect(
      workoutErrorMessage(new ApiError('Internal server error', 500, 'INTERNAL_SERVER_ERROR')),
    ).toBe('That one did not go through. Try again.');
    expect(workoutErrorMessage(new ApiError('bad gateway', 502, 'HTTP_502'))).toBe(
      'The connection dropped part-way. Try again.',
    );
    expect(workoutErrorMessage(new ApiError('x', 200, 'INVALID_RESPONSE'))).toBe(
      'The connection dropped part-way. Try again.',
    );
  });

  it('keeps any other refusal as the server said it', () => {
    expect(workoutErrorMessage(new ApiError('Not for your role.', 403, 'FORBIDDEN'))).toBe(
      'Not for your role.',
    );
  });

  it('knows offline and unknown failures', () => {
    expect(workoutErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'You look to be offline. Check your connection and try again.',
    );
    expect(workoutErrorMessage('?')).toBe('Something went wrong. Try again.');
  });
});

describe('predicates', () => {
  it('recognise the quota 429 and a missing draft', () => {
    expect(isQuotaExhausted(new ApiError('x', 429, 'WORKOUT_AI_LIMIT'))).toBe(true);
    expect(isQuotaExhausted(new ApiError('x', 429, 'HTTP_429'))).toBe(false);
    expect(isDraftMissing(new ApiError('x', 404, 'WORKOUT_DRAFT_MISSING'))).toBe(true);
    expect(isDraftMissing(new ApiError('x', 404, 'HTTP_404'))).toBe(true);
    expect(isDraftMissing(new ApiError('x', 409, 'WORKOUT_DRAFT_NOT_READY'))).toBe(false);
    expect(isDraftMissing(new Error('x'))).toBe(false);
  });
});
