'use client';

import { createClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { PasswordCheck } from './account';

/**
 * The account page's Supabase calls.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CURRENT-PASSWORD CHECK NEVER TOUCHES THE SIGNED-IN SESSION.
 *
 * Supabase has no "check this password" call; the only check is a sign-in.
 * Signing in on the browser's own client would REPLACE the member's session
 * with a new one — and every new session is an unverified sign-in, so the next
 * API call would answer `401 LOGIN_CODE_REQUIRED` and bounce the member to the
 * emailed-code step in the middle of changing their password.
 *
 * So the check signs in on a throwaway client that keeps nothing (no storage,
 * no refresh, no URL detection), and revokes that one session at once
 * (`signOut({ scope: 'local' })` ends only the session it holds). The
 * member's own session, and its verified sign-in, are untouched; the new
 * password is then set on it with `updateUser`.
 * ═══════════════════════════════════════════════════════════════════════════
 */

function probeClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        // Its own key, so it never shares (or warns about) the main client's.
        storageKey: 'got-password-check',
      },
    },
  );
}

export async function verifyCurrentPassword(
  email: string,
  password: string,
): Promise<PasswordCheck> {
  const probe = probeClient();
  const { error } = await probe.auth.signInWithPassword({ email, password });
  if (error !== null) {
    return error.code === 'invalid_credentials' ? 'wrong' : 'error';
  }
  try {
    await probe.auth.signOut({ scope: 'local' });
  } catch {
    // The password was right; a throwaway session that outlives this is a
    // stray refresh token nobody holds, not a reason to fail the change.
  }
  return 'ok';
}

export async function updatePassword(
  password: string,
): Promise<{ error: { message: string } | null }> {
  const { error } = await supabase.auth.updateUser({ password });
  return { error };
}

/** Supabase emails the confirmation link(s); the link lands back on this page. */
export async function updateEmail(email: string): Promise<{ error: { message: string } | null }> {
  const { error } = await supabase.auth.updateUser(
    { email },
    { emailRedirectTo: `${window.location.origin}/portal/account` },
  );
  return { error };
}
