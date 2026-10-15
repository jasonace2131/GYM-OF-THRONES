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
   * `yyyy-mm-dd`, or null when absent, malformed, or below the joining age.
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
}
