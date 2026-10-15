'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Card, EmptyState, Skeleton } from '@/components/portal/ui';
import { hasPermission, type ScopeRequirement } from '@/lib/rbac/permissions';
import { STAFF_HOME, portalHomeFor } from '@/lib/safeNext';
import { useMe } from './MeProvider';

interface GateProps {
  permission: string;
  scope?: ScopeRequirement;
}

/**
 * Renders its children only for a caller holding `permission` (at `scope`).
 *
 * `fallback` is what everybody else sees — nothing, by default, because a
 * control somebody can never use should be absent rather than disabled.
 * While `/me` is loading it renders `loading` if given, else the fallback:
 * never the privileged control.
 */
export function Can({
  permission,
  scope,
  fallback = null,
  loading,
  children,
}: GateProps & { fallback?: ReactNode; loading?: ReactNode; children: ReactNode }) {
  const { status, me } = useMe();
  if (status === 'loading' && me === null) return <>{loading ?? fallback}</>;
  return <>{hasPermission(me?.permissions ?? null, permission, { scope }) ? children : fallback}</>;
}

/**
 * A page guard. Wrap a page's content in it and a caller without the key
 * gets one clean "not for your role" card with a way home — instead of the
 * page's chrome rendering and then filling up with 403 error cards.
 *
 * While `/me` loads it shows a skeleton; if `/me` could not be read at all it
 * says so and offers a retry, because "we could not check" is a different
 * sentence from "you may not".
 */
export function RequirePermission({
  permission,
  scope,
  children,
}: GateProps & { children: ReactNode }) {
  const { status, me, surface, reload } = useMe();
  const permissions = me?.permissions ?? null;

  if (status === 'loading' && me === null) {
    return (
      <div style={{ display: 'grid', gap: 18 }} aria-busy="true">
        <Skeleton height={120} />
        <Skeleton height={220} />
      </div>
    );
  }

  if (me === null) {
    return (
      <Card>
        <EmptyState
          title="We could not check your access"
          hint="This is usually the network. Try again in a moment."
          action={
            <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={reload}>
              Try again
            </button>
          }
        />
      </Card>
    );
  }

  if (!hasPermission(permissions, permission, { scope })) {
    const home = surface === 'admin' ? STAFF_HOME : portalHomeFor(permissions);
    return (
      <Card>
        <EmptyState
          title="This page isn't available for your role"
          hint="If you think you should have access, ask an admin to check your account."
          action={
            <Link href={home} className="p-btn p-btn-gold p-btn-sm">
              Go to your home page
            </Link>
          }
        />
      </Card>
    );
  }

  return <>{children}</>;
}
