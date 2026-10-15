'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useMe } from '@/components/rbac/MeProvider';
import { portalHomeFor } from '@/lib/safeNext';

/**
 * /portal has no content of its own — it forwards to the caller's portal
 * home: the coach dashboard for a coach, the member dashboard for everyone
 * else. Decided by permission (`portalHomeFor`), never by role, and only once
 * `/me` has answered; a failed `/me` falls back to the member dashboard.
 */
export default function PortalIndex() {
  const router = useRouter();
  const { status, me } = useMe();

  useEffect(() => {
    if (status === 'loading') return;
    router.replace(portalHomeFor(me?.permissions ?? null));
  }, [router, status, me]);

  return null;
}
