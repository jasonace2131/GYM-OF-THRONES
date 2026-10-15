import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}));

import { ApiError } from './api';
import {
  classifyMeFailure,
  codeStepFailure,
  isCompleteCode,
  loginCodeErrorMessage,
  normaliseCodeInput,
  resendLabel,
  secondsUntil,
} from './loginCode';

const err = (code: string, status = 422, details?: unknown): ApiError =>
  new ApiError('server words', status, code, details);

describe('normaliseCodeInput', () => {
  it.each([
    ['123456', '123456'],
    ['123 456', '123456'],
    [' 12-34-56 ', '123456'],
    ['Your code: 654321', '654321'],
    ['1234567', '123456'],
    ['abc', ''],
  ])('%p → %p', (raw, expected) => {
    expect(normaliseCodeInput(raw)).toBe(expected);
  });
});

describe('isCompleteCode', () => {
  it('wants exactly six digits', () => {
    expect(isCompleteCode('123456')).toBe(true);
    expect(isCompleteCode('12345')).toBe(false);
    expect(isCompleteCode('12345a')).toBe(false);
  });
});

describe('secondsUntil', () => {
  const now = Date.parse('2026-10-15T02:00:00.000Z');

  it('rounds up, so the button never says 0:00 while still disabled', () => {
    expect(secondsUntil('2026-10-15T02:00:41.200Z', now)).toBe(42);
  });

  it('is 0 at and after the instant, and for nothing or nonsense', () => {
    expect(secondsUntil('2026-10-15T02:00:00.000Z', now)).toBe(0);
    expect(secondsUntil('2026-10-15T01:59:00.000Z', now)).toBe(0);
    expect(secondsUntil(null, now)).toBe(0);
    expect(secondsUntil('not a date', now)).toBe(0);
  });
});

describe('resendLabel', () => {
  it('counts down as m:ss, then offers the button', () => {
    expect(resendLabel(42)).toBe('Resend code in 0:42');
    expect(resendLabel(60)).toBe('Resend code in 1:00');
    expect(resendLabel(0)).toBe('Resend code');
  });
});

describe('classifyMeFailure', () => {
  it('sends LOGIN_CODE_REQUIRED to the code step — never to sign-out', () => {
    expect(classifyMeFailure(err('LOGIN_CODE_REQUIRED', 401))).toBe('code-required');
  });

  it('treats any other 401 as a dead session', () => {
    expect(classifyMeFailure(err('HTTP_401', 401))).toBe('signed-out');
  });

  it('retries everything else, including a bare network TypeError', () => {
    expect(classifyMeFailure(err('HTTP_500', 500))).toBe('retry');
    expect(classifyMeFailure(new TypeError('Failed to fetch'))).toBe('retry');
  });
});

describe('loginCodeErrorMessage', () => {
  it('says how many tries are left on a wrong code', () => {
    expect(loginCodeErrorMessage(err('LOGIN_CODE_INVALID', 422, { attemptsLeft: 3 }))).toBe(
      "That code isn't right. 3 tries left.",
    );
    expect(loginCodeErrorMessage(err('LOGIN_CODE_INVALID', 422, { attemptsLeft: 1 }))).toBe(
      "That code isn't right. 1 try left.",
    );
  });

  it.each([
    ['LOGIN_CODE_INVALID', 422, "That code isn't right. Check the email and try again."],
    ['LOGIN_CODE_EXPIRED', 422, 'That code has expired. Tap Resend code for a new one.'],
    ['LOGIN_CODE_LOCKED', 422, 'Too many wrong tries. Tap Resend code for a new one.'],
    [
      'LOGIN_CODE_SEND_LIMIT',
      429,
      "We've sent as many codes as we can for now. Wait a while, then sign in again.",
    ],
    ['LOGIN_CODE_EMAIL_FAILED', 503, "We couldn't send the email — ask the gym."],
    ['HTTP_400', 400, 'Enter the 6-digit code from the email.'],
    ['HTTP_429', 429, 'Too many tries. Wait a minute, then try again.'],
    ['HTTP_500', 500, 'Something went wrong. Please try again.'],
  ])('%s reads as words, never as a code', (code, status, expected) => {
    expect(loginCodeErrorMessage(err(code, status))).toBe(expected);
  });

  it('explains a network failure', () => {
    expect(loginCodeErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'Something went wrong. Check your connection and try again.',
    );
  });
});

describe('codeStepFailure', () => {
  it('ends the code step on a 401 that is not LOGIN_CODE_REQUIRED', () => {
    expect(codeStepFailure(err('UNAUTHORIZED', 401))).toBe('session-ended');
    expect(codeStepFailure(err('HTTP_401', 401))).toBe('session-ended');
  });

  it('keeps the code step on LOGIN_CODE_REQUIRED — the session is fine', () => {
    expect(codeStepFailure(err('LOGIN_CODE_REQUIRED', 401))).toBe('stay');
  });

  it('starts over on the send cap, whose words say "sign in again"', () => {
    expect(codeStepFailure(err('LOGIN_CODE_SEND_LIMIT', 429))).toBe('start-over');
  });

  it.each([
    ['LOGIN_CODE_INVALID', 422],
    ['LOGIN_CODE_EXPIRED', 422],
    ['LOGIN_CODE_LOCKED', 422],
    ['LOGIN_CODE_EMAIL_FAILED', 503],
    ['HTTP_429', 429],
    ['HTTP_500', 500],
  ])('stays on the code step for %s', (code, status) => {
    expect(codeStepFailure(err(code, status))).toBe('stay');
  });

  it('stays on the code step for a network failure', () => {
    expect(codeStepFailure(new TypeError('Failed to fetch'))).toBe('stay');
  });
});
