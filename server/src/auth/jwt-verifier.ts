import { jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { SupabaseClaims } from './auth.types';
import { isPlausibleBirthDate, normalisePhPhone, sanitisePersonName } from '@got/shared';
import { latestToday } from '../common/validators/is-birth-date.validator';

interface RawUserMetadata {
  firstName?: unknown;
  lastName?: unknown;
  phone?: unknown;
  heightCm?: unknown;
  weightKg?: unknown;
  dateOfBirth?: unknown;
}

/**
 * `yyyy-mm-dd` from a date input, or null (owner, 2026-10-23: NO minimum age).
 *
 * A real calendar date from 1900-01-01 up to today — never in the future —
 * the same rule every DOB input and `IsBirthDate` apply. Returned as the
 * civil-date STRING, not a Date: a birthday is a calendar date, not an
 * instant. Anything else is dropped rather than stored.
 */
export function asBirthDate(value: unknown, now: number = Date.now()): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  return isPlausibleBirthDate(raw, latestToday(now)) ? raw : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Coerces a metadata value to a number within sane bounds.
 *
 * Values arrive from a registration form, so they may be strings, empty, or
 * nonsense. Anything outside the range is discarded rather than stored — a
 * 4000kg client is a typo, not a data point, and silently keeping it poisons
 * every average and chart built on the column later.
 */
function asBoundedNumber(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : Number(asString(value));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  // One decimal place is all a gym scale or tape measure gives you.
  return Math.round(n * 10) / 10;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sign-in id, lower-cased, or null when absent or not a uuid. */
function asSessionId(value: unknown): string | null {
  const raw = asString(value);
  return raw !== null && UUID.test(raw) ? raw.toLowerCase() : null;
}

/**
 * `amr` method names. Supabase sends `[{ method, timestamp }]`; a bare string
 * entry is accepted too. Anything unusable is dropped, never guessed at.
 */
function asAmrMethods(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const methods: string[] = [];
  for (const entry of value) {
    const method =
      typeof entry === 'string'
        ? entry
        : entry !== null && typeof entry === 'object'
          ? (entry as { method?: unknown }).method
          : undefined;
    if (typeof method === 'string' && method.trim() !== '') {
      methods.push(method.trim().toLowerCase());
    }
  }
  return methods;
}

/**
 * Verifies a Supabase access token and narrows it to the claims this app uses.
 *
 * The key resolver is a parameter rather than something this function builds,
 * so tests can pass a locally generated JWKS and exercise real signature
 * checking without touching the network.
 *
 * `algorithms` is pinned to ES256 deliberately: leaving it open would let a
 * forged token nominate its own algorithm.
 */
export async function verifyAccessToken(
  token: string,
  keys: JWTVerifyGetKey,
  issuer: string,
): Promise<SupabaseClaims> {
  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience: 'authenticated',
    algorithms: ['ES256'],
  });

  const sub = asString(payload.sub);
  if (!sub) throw new Error('Invalid token: missing sub claim');
  const sessionId = asSessionId(payload['session_id']);
  if (!sessionId) throw new Error('Invalid token: missing session_id claim');

  const email = asString(payload['email']) ?? '';
  const metadata = (payload['user_metadata'] ?? {}) as RawUserMetadata;

  // Supabase sign-up carries names in user_metadata. A user created another
  // way (dashboard, OAuth) may have none, so fall back to the email
  // local-part rather than failing — provisioning still needs a name.
  //
  // Metadata is UNVALIDATED input: anybody can call Supabase signUp with the
  // public anon key. Names are sanitised to the shared name rule (an empty
  // result falls through to the next source), and the phone must be a PH
  // mobile, stored as +639XXXXXXXXX, or it is dropped.
  const firstName =
    sanitisePersonName(metadata.firstName) || sanitisePersonName(email.split('@')[0]) || 'Member';

  return {
    sub,
    email,
    firstName,
    lastName: sanitisePersonName(metadata.lastName),
    phone: normalisePhPhone(metadata.phone),
    // Bounds cover every real adult with room to spare; anything outside is a
    // typo or a unit mix-up (lbs entered as kg) and is dropped.
    heightCm: asBoundedNumber(metadata.heightCm, 50, 260),
    weightKg: asBoundedNumber(metadata.weightKg, 20, 400),
    dateOfBirth: asBirthDate(metadata.dateOfBirth),
    sessionId,
    amr: asAmrMethods(payload['amr']),
  };
}
