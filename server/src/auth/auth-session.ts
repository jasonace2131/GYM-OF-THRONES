import type { AuthSession, SupabaseClaims } from './auth.types';

/**
 * `amr` methods that prove the person opened a link in the inbox — exactly
 * what the emailed code proves (spec Ruling A). `otp` is the magic link (the
 * counter setup link), `invite` the staff invitation, `recovery` the password
 * reset. Supabase has reported a magic link as both `otp` and `magiclink`.
 *
 * The Realtime migration 20261015000100_login_code_realtime lists the same
 * four. Change both together.
 */
export const EMAIL_LINK_AMR_METHODS: readonly string[] = ['otp', 'magiclink', 'invite', 'recovery'];

/** The sign-in behind a verified token, as the gate needs it. */
export function authSessionFrom(claims: Pick<SupabaseClaims, 'sessionId' | 'amr'>): AuthSession {
  return {
    sessionId: claims.sessionId,
    viaEmailLink: claims.amr.some((method) => EMAIL_LINK_AMR_METHODS.includes(method)),
  };
}
