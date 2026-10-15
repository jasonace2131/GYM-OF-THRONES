/**
 * Which credential the station display sends — the one branching decision the
 * display's two modes differ on, kept pure so it can be tested on its own.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO WAYS TO PAINT THE SAME CODE.
 *
 *   TABLET (default) — the mounted lobby panel. Authenticates with its own
 *     `X-Station-Key`, a per-tablet secret issued from Admin → Stations. It
 *     has no user and no session, and must never start depending on one: a
 *     login that expires overnight would take the lobby screen down with it.
 *
 *   STAFF (`/desk/station?mode=staff`) — the "Show check-in QR" button in the
 *     console. Authenticates with the signed-in staff member's own Supabase
 *     session, which `StationTokenAccessGuard` already accepts when the
 *     account holds `checkin.station_token.issue`. No tablet key is involved,
 *     so the front desk can put the code up without an admin provisioning
 *     anything.
 *
 * The two never mix. A tablet never sends a Bearer token even if somebody
 * happens to be signed in on it, and the staff display never sends a stored
 * tablet key — if it did, the guard would take the key path and the code
 * would stop being attributable to the person who put it up.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type StationMode = 'tablet' | 'staff';

/** Where the console's "Show check-in QR" button goes. */
export const STAFF_QR_PATH = '/desk/station?mode=staff';

/** `?mode=staff`, exactly, is staff mode. Anything else is the tablet. */
export function stationModeFrom(param: string | null): StationMode {
  return param === 'staff' ? 'staff' : 'tablet';
}

export type StationCredential =
  | { kind: 'STATION_KEY'; key: string }
  | { kind: 'STAFF_SESSION'; accessToken: string };

export type CredentialChoice =
  | { kind: 'SEND'; credential: StationCredential }
  /** A tablet with no key yet — show the setup wizard. */
  | { kind: 'UNCONFIGURED' }
  /** Staff mode with no session — send them to sign in. */
  | { kind: 'SIGNED_OUT' };

function present(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}

export function chooseStationCredential(input: {
  mode: StationMode;
  stationKey: string | null;
  accessToken: string | null;
}): CredentialChoice {
  if (input.mode === 'staff') {
    return present(input.accessToken)
      ? { kind: 'SEND', credential: { kind: 'STAFF_SESSION', accessToken: input.accessToken } }
      : { kind: 'SIGNED_OUT' };
  }

  return present(input.stationKey)
    ? { kind: 'SEND', credential: { kind: 'STATION_KEY', key: input.stationKey } }
    : { kind: 'UNCONFIGURED' };
}

/** Exactly one auth header, never both — the guard picks its path by which one it sees. */
export function stationAuthHeaders(credential: StationCredential): Record<string, string> {
  return credential.kind === 'STATION_KEY'
    ? { 'X-Station-Key': credential.key }
    : { Authorization: `Bearer ${credential.accessToken}` };
}

export type StationAuthFailure = 'REVOKED' | 'SESSION_EXPIRED' | 'FORBIDDEN';

/**
 * What a 401/403 means, which depends on who was asking.
 *
 * For a tablet both mean the same thing — its key was revoked or never
 * existed — and the display shows the re-provision diagnostic. For a staff
 * session they differ: 401 is a login that expired (go and sign in again),
 * 403 is an account that may not show the code at all (signing in again
 * would change nothing).
 */
export function authFailureFor(
  kind: StationCredential['kind'],
  status: number,
): StationAuthFailure | null {
  if (status !== 401 && status !== 403) return null;
  if (kind === 'STATION_KEY') return 'REVOKED';
  return status === 401 ? 'SESSION_EXPIRED' : 'FORBIDDEN';
}

/**
 * Which station to ask for.
 *
 * A tablet uses the code it was set up with. The staff display takes
 * `?station=` from its own URL and ignores anything stored on the device —
 * a desk PC that was once set up as a tablet must not silently pin the staff
 * display to that station. With no code the server picks the one active
 * station, which is the v1 case.
 */
export function stationCodeFor(input: {
  mode: StationMode;
  storedCode: string | null;
  param: string | null;
}): string | null {
  if (input.mode === 'tablet') return input.storedCode;
  const code = input.param?.trim().toUpperCase() ?? '';
  return code.length === 0 ? null : code;
}

/** Sign in, then come straight back to the staff display. */
export function staffLoginPath(): string {
  return `/login?next=${encodeURIComponent(STAFF_QR_PATH)}`;
}
