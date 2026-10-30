'use client';

import type { LoginCodeInvalidDetails, LoginCodeSendResult, LoginCodeVerified } from '@got/shared';
import { ApiError, apiFetch } from './api';
import { LOGIN_CODE_REQUIRED, SESSION_REPLACED } from './loginCodeRedirect';

/**
 * The login page's second step: password, then a 6-digit code emailed by our
 * API. Everything here is the page's logic without React, so it can be tested.
 */
export const LOGIN_CODE_DIGITS = 6;

/**
 * `token` is passed straight after `signInWithPassword`, because Supabase
 * stores the new session asynchronously and `getSession()` can still return
 * the old one for a moment (see LoginPage).
 */
export function sendLoginCode(token?: string): Promise<LoginCodeSendResult> {
  return apiFetch<LoginCodeSendResult>('/auth/login-code', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export function verifyLoginCode(code: string): Promise<LoginCodeVerified> {
  return apiFetch<LoginCodeVerified>('/auth/login-code/verify', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

/** Digits only, at most six — what a paste of "123 456" or "Your code: 123456" should become. */
export function normaliseCodeInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, LOGIN_CODE_DIGITS);
}

export function isCompleteCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** Whole seconds until `iso`, rounded up; 0 when past, absent or unreadable. */
export function secondsUntil(iso: string | null, nowMs: number): number {
  if (iso === null) return 0;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

export function resendLabel(secondsLeft: number): string {
  if (secondsLeft <= 0) return 'Resend code';
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  return `Resend code in ${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * What a failed `/me` means on the login page. LOGIN_CODE_REQUIRED is a 401
 * too, and must NOT reach the "session could not be verified → sign out"
 * branch: the session is fine, it just needs its code.
 *
 * Nor may SESSION_REPLACED: that branch signs out GLOBALLY, which would also
 * end the sign-in on the device that just replaced this one. `apiFetch` has
 * already signed this device out locally; the page only shows why.
 *
 * `too-young`: the API will not create an account for this sign-up, because
 * its date of birth is under 12 (owner, 2026-10-30). Retrying cannot help, so
 * the page signs the session out and shows `MINIMUM_AGE_MESSAGE`.
 */
export function classifyMeFailure(
  caught: unknown,
): 'code-required' | 'replaced' | 'too-young' | 'signed-out' | 'retry' {
  if (caught instanceof ApiError && caught.code === LOGIN_CODE_REQUIRED) return 'code-required';
  if (caught instanceof ApiError && caught.code === SESSION_REPLACED) return 'replaced';
  if (caught instanceof ApiError && caught.code === 'AGE_REQUIREMENT_NOT_MET') return 'too-young';
  if (caught instanceof ApiError && caught.status === 401) return 'signed-out';
  return 'retry';
}

/** The password step's message when the code step's session is gone. */
export const SIGN_IN_ENDED_MESSAGE = 'Your sign-in ended. Please sign in again.';

/**
 * What a failed verify or resend does to the code step.
 *
 * - `replaced`: SESSION_REPLACED. The two code routes never answer it, but a
 *   401 that did must not reach `session-ended`, whose sign-out is GLOBAL and
 *   would end the newer device's sign-in too. Back to the password step with
 *   the reason, and no further sign-out (`apiFetch` signed out locally).
 * - `session-ended`: a 401 that is not LOGIN_CODE_REQUIRED — the session was
 *   revoked or signed out in another tab. No code can rescue it, so the page
 *   signs out and goes back to the password step.
 * - `start-over`: the send cap. The message says "sign in again", so the page
 *   signs out and puts that message on the password step, where the sign-in is.
 * - `stay`: everything else; show the message and let them retry here.
 */
export function codeStepFailure(
  caught: unknown,
): 'replaced' | 'session-ended' | 'start-over' | 'stay' {
  if (!(caught instanceof ApiError)) return 'stay';
  if (caught.code === SESSION_REPLACED) return 'replaced';
  if (caught.code === 'LOGIN_CODE_SEND_LIMIT') return 'start-over';
  if (caught.status === 401 && caught.code !== LOGIN_CODE_REQUIRED) return 'session-ended';
  return 'stay';
}

function attemptsLeftOf(details: unknown): number | null {
  if (details === null || typeof details !== 'object') return null;
  const left = (details as Partial<LoginCodeInvalidDetails>).attemptsLeft;
  return typeof left === 'number' ? left : null;
}

/** Every failure of the code step, in words. Never shows a raw code. */
export function loginCodeErrorMessage(caught: unknown): string {
  if (!(caught instanceof ApiError)) {
    return 'Something went wrong. Check your connection and try again.';
  }
  switch (caught.code) {
    case 'LOGIN_CODE_INVALID': {
      const left = attemptsLeftOf(caught.details);
      return left === null
        ? "That code isn't right. Check the email and try again."
        : `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
    }
    case 'LOGIN_CODE_EXPIRED':
      return 'That code has expired. Tap Resend code for a new one.';
    case 'LOGIN_CODE_LOCKED':
      return 'Too many wrong tries. Tap Resend code for a new one.';
    case 'LOGIN_CODE_SEND_LIMIT':
      return "We've sent as many codes as we can for now. Wait a while, then sign in again.";
    case 'LOGIN_CODE_EMAIL_FAILED':
      return "We couldn't send the email — ask the gym.";
    case 'HTTP_400':
      return 'Enter the 6-digit code from the email.';
    case 'HTTP_429':
      return 'Too many tries. Wait a minute, then try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
