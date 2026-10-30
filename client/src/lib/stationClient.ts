'use client';

import type { StationTokenBatch } from '@got/shared';
import { API_URL } from './apiBase';
import { authFailureFor, stationAuthHeaders, type StationCredential } from './stationAuth';

/**
 * The station display's own HTTP client.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT `apiFetch`.
 *
 * `apiFetch` attaches the current Supabase access token. The station display
 * HAS NO USER: it is a mounted tablet holding one opaque, per-station,
 * revocable secret, with no `User` row, no JWT and no permission set. Reusing
 * the member client would mean either signing a tablet in as somebody — whose
 * session then expires overnight and takes the lobby screen down with it — or
 * carrying a permanent staff token on an unattended device in a public room.
 *
 * A separate credential is also what makes the OFF SWITCH real: revoking one
 * `StationCredential` kills one tablet, immediately, without touching a single
 * member or rotating a global secret.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The key lives in `localStorage`, not `sessionStorage`: the tablet reboots
 * after a power cut and must come back painting codes without a human walking
 * over with the key. That it survives a reboot is the point.
 *
 * THE ONE EXCEPTION is the console's "Show check-in QR" (`?mode=staff`),
 * which sends the signed-in staff member's own access token instead of a
 * key — see `stationAuth.ts` for why the two never mix. The caller decides
 * which credential; this file only sends it.
 */

/** One key per tablet, set once at mount time. */
export const STATION_KEY_STORAGE = 'got.station.key';
/** Optional: pins this tablet to a station when more than one is active. */
export const STATION_CODE_STORAGE = 'got.station.code';

export function readStationKey(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STATION_KEY_STORAGE);
}

export function readStationCode(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STATION_CODE_STORAGE);
}

export function saveStationCredential(key: string, code: string): void {
  window.localStorage.setItem(STATION_KEY_STORAGE, key.trim());
  const trimmed = code.trim().toUpperCase();
  if (trimmed.length > 0) window.localStorage.setItem(STATION_CODE_STORAGE, trimmed);
  else window.localStorage.removeItem(STATION_CODE_STORAGE);
}

export function forgetStationCredential(): void {
  window.localStorage.removeItem(STATION_KEY_STORAGE);
  window.localStorage.removeItem(STATION_CODE_STORAGE);
}

/**
 * Every distinguishable outcome the display has to render differently.
 *
 * `CLOSED`, `REVOKED` and `STALE` are separated from plain `OFFLINE` because
 * each one changes what the display does next — back off the poll, show the
 * staff diagnostic, or discard the cache on the same tick. Everything else a
 * member could not act on differently is collapsed.
 */
export type StationFetchResult =
  | { kind: 'OK'; batch: StationTokenBatch; receivedAtMs: number }
  /** Outside `[open − 15m, close + 15m]`. Carries the real opening time. */
  | { kind: 'CLOSED'; nextOpensAt: string | null }
  /** 401/403 — this tablet's credential was revoked, or never existed. */
  | { kind: 'REVOKED' }
  /** 401 on the staff display — the login expired; sign in again. */
  | { kind: 'SESSION_EXPIRED' }
  /**
   * 401 SESSION_REPLACED on the staff display — the account signed in on
   * another device. The page signs out locally and says so on the login page.
   */
  | { kind: 'SESSION_REPLACED' }
  /** 403 on the staff display — this account may not show the code. */
  | { kind: 'FORBIDDEN' }
  /** Any other failure: no network, a 500, a proxy error page. */
  | { kind: 'OFFLINE'; message: string };

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

function stationHeaders(credential: StationCredential): Record<string, string> {
  return { 'Content-Type': 'application/json', ...stationAuthHeaders(credential) };
}

function stationQuery(code: string | null): string {
  // Omitted when exactly one station is active, which is the v1 case. Sending
  // a stale code after a rename would 404 a working tablet.
  return code === null || code.length === 0 ? '' : `?station=${encodeURIComponent(code)}`;
}

export async function fetchStationBatch(
  credential: StationCredential,
  code: string | null,
): Promise<StationFetchResult> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/checkin/station-tokens${stationQuery(code)}`, {
      headers: stationHeaders(credential),
      cache: 'no-store',
    });
  } catch (error) {
    return { kind: 'OFFLINE', message: (error as Error).message };
  }

  const refused = authFailureFor(credential.kind, response.status);
  // Read as a literal, like GYM_CLOSED below: this file imports nothing that
  // touches Supabase, and `sessionReplaced.ts` does.
  if (refused === 'SESSION_EXPIRED' && (await errorCodeOf(response)) === 'SESSION_REPLACED') {
    return { kind: 'SESSION_REPLACED' };
  }
  if (refused !== null) return { kind: refused };

  let body: Envelope<StationTokenBatch>;
  try {
    body = (await response.json()) as Envelope<StationTokenBatch>;
  } catch {
    // A proxy error page rather than a server envelope. Captive portals do
    // this, and a captive portal on the gym's own SSID is a real failure mode.
    return { kind: 'OFFLINE', message: `Non-JSON response (${response.status})` };
  }

  if (response.status === 410 || body.error?.code === 'GYM_CLOSED') {
    const details = body.error?.details as { nextOpensAt?: string } | undefined;
    return { kind: 'CLOSED', nextOpensAt: details?.nextOpensAt ?? null };
  }

  if (!response.ok || !body.success || body.data === undefined) {
    return { kind: 'OFFLINE', message: body.error?.message ?? `HTTP ${response.status}` };
  }

  return { kind: 'OK', batch: body.data, receivedAtMs: Date.now() };
}

/** The envelope's error code, or null when the body is not one. */
async function errorCodeOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as Envelope<unknown>;
    return body.error?.code ?? null;
  } catch {
    return null;
  }
}

/**
 * The epoch head check, polled every slot boundary.
 *
 * THIS IS WHAT MAKES THE PANIC BUTTON IMMEDIATE. Without it, bumping a
 * station's `tokenEpoch` because a tablet was stolen would leave the real
 * display painting dead codes for a full batch — five minutes of members
 * scanning something that cannot work, which is exactly the outcome the
 * "never render a code you cannot prove is in window" rule forbids.
 *
 * A network failure returns `false`. Discarding a good batch because one poll
 * timed out would take the screen down for a blip, and the batch's own
 * `notAfter` already bounds how long a stale one can be painted.
 */
export async function isBatchStale(
  credential: StationCredential,
  code: string | null,
  batchEtag: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/checkin/station-tokens/head${stationQuery(code)}`, {
      headers: { ...stationHeaders(credential), 'If-None-Match': batchEtag },
      cache: 'no-store',
    });
    // 204 means the cached batch is still good; 409 means the epoch moved.
    return response.status === 409;
  } catch {
    return false;
  }
}
