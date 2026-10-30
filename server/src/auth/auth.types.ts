import type { Role, UserStatus } from '@prisma/client';

/**
 * The subset of Supabase JWT claims this application relies on.
 *
 * Deliberately narrow: everything here has been cryptographically verified,
 * and anything not listed is ignored rather than trusted.
 */
export interface SupabaseClaims {
  /** Supabase user id (uuid). Maps to User.supabaseId. */
  sub: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  /** Metric. Null when not supplied at sign-up or outside sane bounds. */
  heightCm: number | null;
  /** Metric. Null when not supplied at sign-up or outside sane bounds. */
  weightKg: number | null;
  /**
   * `yyyy-mm-dd`, or null when absent, malformed, in the future, or 120 or
   * more years back. A date under the minimum account age is kept: provisioning
   * refuses the account on it.
   *
   * A STRING, not a Date: a birthday is a calendar date and parsing it into
   * an instant here is how it drifts by a day for anyone east of UTC.
   */
  dateOfBirth: string | null;
  /**
   * The Supabase sign-in this token belongs to (`session_id`, lower-case
   * uuid). One per sign-in, repeated by every refreshed token of it. A token
   * without one is refused: a sign-in we cannot identify cannot be verified.
   */
  sessionId: string;
  /** `amr` method names, lower-case: how this sign-in happened ('password', 'otp', …). */
  amr: string[];
  /**
   * When this sign-in happened: the latest `amr` timestamp. Unchanged by token
   * refreshes, so it identifies the sign-in's age, not the token's. Null when
   * the token carries none; such a sign-in can never displace another device.
   */
  signedInAt: Date | null;
}

/**
 * The authenticated user AuthGuard attaches to every request.
 *
 * Note there is no `role` or `status` here that came from the token — both are
 * read from our own database. A token claim must never be able to set them.
 *
 * `deletedAt` is carried even though the guard rejects on it, because
 * UserProvisioningService needs it to decide not to write, and a caller that
 * only sees `status` would think a deleted account is usable.
 */
export interface AuthUser {
  id: string;
  supabaseId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  status: UserStatus;
  permissionVersion: number;
  heightCm: number | null;
  weightKg: number | null;
  deletedAt: Date | null;
}

/**
 * The sign-in behind a request, attached by AuthGuard as `request.authSession`
 * beside `request.user`. The emailed-code gate keys on `sessionId`.
 */
export interface AuthSession {
  sessionId: string;
  /** Created by a link opened in the inbox (magic link, invite, password reset). */
  viaEmailLink: boolean;
  /** When the sign-in happened (`SupabaseClaims.signedInAt`). The one-device rule compares it. */
  signedInAt: Date | null;
}

/**
 * The account's one current sign-in (the one-device rule): `User.activeSessionId`
 * and `User.activeSessionSignedInAt`. Both null until a verified sign-in first
 * makes a request. Read by provisioning's per-request read and handed to
 * `SingleSessionService`; never part of `AuthUser`, so it cannot reach a
 * response by way of `@CurrentUser()`.
 */
export interface ActiveSession {
  sessionId: string | null;
  signedInAt: Date | null;
}
