'use client';

import { supabase } from './supabase';
import { API_URL } from './apiBase';
import { LOGIN_CODE_REQUIRED, browserNavigation, loginCodeRedirectFor } from './loginCodeRedirect';

/** Matches ApiSuccessResponse / ApiErrorResponse from the server's global interceptors. */
interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

/**
 * A failed API call, carrying the two things a screen needs to react.
 *
 * `status` distinguishes 401 (session died → send them to /login?next=), 403,
 * and 429 (silent retry). `code` is the server's DomainErrorCode when the
 * failure was a named business failure, so the portal can branch on the reason
 * rather than string-matching a message.
 *
 * Still an Error with the same `message`, so every existing caller is unaffected.
 *
 * Note what this is NOT for: a check-in denial is a 200 with a payload, never a
 * throw. A denial thrown here would reach a member's phone as a blank card at
 * the counter with no reason and no next step.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The envelope's structured extras, when the error carries any (`error.details`). */
  readonly details: unknown;

  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type ForbiddenListener = (path: string) => void;
const forbiddenListeners = new Set<ForbiddenListener>();

/**
 * Subscribe to every 403 `apiFetch` sees. Returns the unsubscribe.
 *
 * A 403 usually means the permission set on screen is stale — a grant was
 * revoked since `/me` was read — so each surface's `MeProvider` listens and
 * re-fetches `/me`, and its nav and page guards catch up. Purely a signal:
 * `apiFetch` throws exactly what it always threw, and a listener that throws
 * cannot change that.
 */
export function onApiForbidden(listener: ForbiddenListener): () => void {
  forbiddenListeners.add(listener);
  return () => {
    forbiddenListeners.delete(listener);
  };
}

function notifyForbidden(path: string): void {
  for (const listener of forbiddenListeners) {
    try {
      listener(path);
    } catch {
      // A listener's bug must never replace the caller's ApiError.
    }
  }
}

/**
 * The sign-in has not entered its emailed code: send the browser to the login
 * page's code step, which comes back here afterwards. The caller still gets
 * its ApiError — navigation is a side effect, never a substitute for the throw.
 */
function redirectForLoginCode(): void {
  if (typeof window === 'undefined') return;
  const target = loginCodeRedirectFor(window.location.pathname, window.location.search);
  if (target !== null) browserNavigation.assign(target);
}

/**
 * Calls the NestJS API with the current Supabase access token attached, and
 * unwraps the { success, data } envelope the server always returns.
 *
 * Every caller gets the unwrapped payload or an ApiError — no endpoint needs to
 * know the envelope shape.
 *
 * The Idempotency-Key is minted HERE, on every POST, and never by a call site:
 * a shared wrapper cannot forget it, whereas each call site can. That is
 * precisely why it is a header and not a body field. GETs never carry one —
 * they write nothing, and sending it would put a row in the replay table for
 * every read.
 *
 * `Idempotency-Key` must appear in the server's CORS allowedHeaders or the
 * browser strips it at preflight, and the failure presents as duplicate
 * charges rather than as a CORS problem.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const method = (init.method ?? 'GET').toUpperCase();

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
      ...init.headers,
    },
  });

  let body: ApiEnvelope<T>;
  try {
    body = (await response.json()) as ApiEnvelope<T>;
  } catch {
    // A proxy error page or a truncated response — never a server envelope.
    throw new ApiError(
      `Request to ${path} returned a non-JSON response`,
      response.status,
      'INVALID_RESPONSE',
    );
  }

  if (!response.ok || !body.success) {
    if (response.status === 403) notifyForbidden(path);
    const error = new ApiError(
      body.error?.message ?? `Request failed with ${response.status}`,
      response.status,
      body.error?.code ?? `HTTP_${response.status}`,
      body.error?.details,
    );
    if (error.code === LOGIN_CODE_REQUIRED) redirectForLoginCode();
    throw error;
  }

  return body.data as T;
}
