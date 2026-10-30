import type { AuthSession, SupabaseClaims } from './auth.types';

/**
 * `amr` methods that prove the person opened a link in the inbox — exactly
 * what the emailed code proves (spec Ruling A). `otp` is the magic link (the
 * counter setup link), `invite` the staff invitation, `recovery` the password
 * reset. Supabase has reported a magic link as both `otp` and `magiclink`.
 * `email_change` is the confirmation link of a member's own email change (My
 * account, feat/member-account): it lands as a fresh session, and opening it
 * proves inbox access just as the others do.
 *
 * The Realtime function `public.login_session_verified()` lists the same
 * methods — most recently re-created by migration
 * 20261020000000_share_medical_with_planner. Change both together
 * (auth-session.spec.ts checks they agree).
 */
export const EMAIL_LINK_AMR_METHODS: readonly string[] = [
  'otp',
  'magiclink',
  'invite',
  'recovery',
  'email_change',
];

/** The sign-in behind a verified token, as the gate and the one-device rule need it. */
export function authSessionFrom(
  claims: Pick<SupabaseClaims, 'sessionId' | 'amr' | 'signedInAt'>,
): AuthSession {
  return {
    sessionId: claims.sessionId,
    viaEmailLink: claims.amr.some((method) => EMAIL_LINK_AMR_METHODS.includes(method)),
    signedInAt: claims.signedInAt,
  };
}
