'use client';

import { supabase } from '@/lib/supabase';
import { clearMemberDeviceCache } from '@/lib/deviceCache';

/**
 * The portal's one sign-out, shared by the shell (sidebar, More sheet) and My
 * account's list row.
 *
 * The device cache is cleared FIRST, so a failing signOut still leaves no
 * member identity on the device: a shared or resold phone must not render the
 * previous member's name, code and photo on a card designed to be handed to
 * staff.
 *
 * `local` after an account deletion: the server has already deleted the
 * Supabase user and every session with it, so a global sign-out would only
 * fail — the browser just has to forget its own copy.
 */
export async function signOutMember(scope: 'global' | 'local' = 'global'): Promise<void> {
  clearMemberDeviceCache();
  try {
    await supabase.auth.signOut(scope === 'local' ? { scope: 'local' } : undefined);
  } catch {
    // Nothing left to do: the cache is gone and the caller navigates away.
  }
}

