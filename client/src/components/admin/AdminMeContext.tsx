'use client';

import type { ReactNode } from 'react';
import { StaticMeProvider, useMe, type Me } from '@/components/rbac/MeProvider';

/**
 * The console's `/me`, under its old names.
 *
 * The console now reads the caller through the shared `MeProvider`
 * (`components/rbac/MeProvider.tsx`), which the admin layout mounts and which
 * keeps the profile fresh on focus and after a 403. These exports are kept so
 * code written against the old context still compiles and still works; new
 * code should use `useMe`, `usePermission`, `<Can>` or `<RequirePermission>`
 * directly, and never rebuild a permission set by hand.
 */
export type AdminMe = Me;

/** A provider with a profile already in hand — see `StaticMeProvider`. */
export function AdminMeProvider({ me, children }: { me: AdminMe; children: ReactNode }) {
  return (
    <StaticMeProvider me={me} surface="admin">
      {children}
    </StaticMeProvider>
  );
}

/**
 * The caller's own profile, or null until it has loaded. Inside the console
 * that is never observed: the shell does not render its children until `/me`
 * has answered and the caller is staff.
 */
export function useAdminMe(): AdminMe | null {
  return useMe().me;
}
