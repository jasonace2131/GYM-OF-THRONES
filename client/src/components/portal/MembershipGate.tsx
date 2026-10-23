'use client';

import { createContext, useContext, type ReactNode } from 'react';
import Link from 'next/link';
import type { MemberAccess } from '@got/shared';
import { useMe } from '@/components/rbac/MeProvider';
import { Card, EmptyState } from '@/components/portal/ui';
import {
  FEATURE_COPY,
  MEMBERSHIP_NOTICE,
  RENEW_HREF,
  memberAccessOf,
  type GatedFeature,
} from '@/lib/memberAccess';

/**
 * The member-only features' gate (owner, 2026-10-17): Workouts, Ask the Gym,
 * My Progress and My Coach need an ACTIVE membership.
 *
 *   - LOCKED (never had one): the feature's locked page instead of the page.
 *   - READ_ONLY (has one, not active): a slim notice above the page, and
 *     `useMemberCanWrite()` false below it, so the page shows its history and
 *     switches off what would write or spend AI.
 *   - FULL (active, or staff): the page, untouched.
 *
 * It only explains. The server refuses every gated write with 403
 * MEMBERSHIP_REQUIRED whatever this renders. The tab stays in the nav either
 * way — the nav is built from permissions, never from membership.
 *
 * Inline styles and the portal's own classes only: this folder is not one
 * Tailwind scans.
 */

/** FULL outside any gate: coaches and the console use the same components. */
const AccessContext = createContext<MemberAccess>('FULL');

/** Whether the caller may write in the member-only feature around them. */
export function useMemberCanWrite(): boolean {
  return useContext(AccessContext) === 'FULL';
}

export function MembershipGate({
  feature,
  children,
}: {
  feature: GatedFeature;
  children: ReactNode;
}) {
  const { me } = useMe();
  const access = memberAccessOf(me);

  // Nothing of the feature until `/me` answers: never flash a page that is
  // about to be locked. The pages' own guards show their loading state.
  if (access === null) return null;

  if (access === 'LOCKED') return <LockedFeature feature={feature} />;

  return (
    <AccessContext.Provider value={access}>
      {access === 'READ_ONLY' ? <MembershipNotice /> : null}
      {children}
    </AccessContext.Provider>
  );
}

/**
 * A screen that exists only to write — a new plan, a draft, a workout in
 * progress. For a read-only member it says so and points back to the history
 * instead of opening a form every button of which would be refused.
 */
export function WritesOnly({
  backHref,
  backLabel,
  children,
}: {
  backHref: string;
  backLabel: string;
  children: ReactNode;
}) {
  if (useMemberCanWrite()) return <>{children}</>;
  return (
    <Card>
      <EmptyState
        title="Renew to use this"
        hint="Your past plans and workouts are still here to look back on."
        action={
          <Link href={backHref} className="p-btn p-btn-ghost p-btn-sm">
            {backLabel}
          </Link>
        }
      />
    </Card>
  );
}

function LockedFeature({ feature }: { feature: GatedFeature }) {
  const copy = FEATURE_COPY[feature];
  return (
    <Card>
      <div style={{ maxWidth: 420, margin: '0 auto', padding: '28px 4px', textAlign: 'center' }}>
        <h1
          style={{
            margin: 0,
            fontFamily: 'var(--font-heading)',
            fontSize: 19,
            fontWeight: 700,
            color: 'var(--p-ink)',
            overflowWrap: 'anywhere',
          }}
        >
          {copy.title}
        </h1>
        <p className="p-muted" style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.5 }}>
          {copy.line}
        </p>
        <div style={{ marginTop: 18 }}>
          <Link href={RENEW_HREF} className="p-btn p-btn-dark">
            Choose a plan
          </Link>
        </div>
      </div>
    </Card>
  );
}

function MembershipNotice() {
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px 16px',
        marginBottom: 16,
        padding: '10px 14px',
        borderRadius: 'var(--p-radius)',
        border: '1px solid var(--p-border)',
        background: 'var(--p-paper2)',
      }}
    >
      <p style={{ margin: 0, minWidth: 0, fontSize: 13.5, color: 'var(--p-ink)' }}>
        {MEMBERSHIP_NOTICE}
      </p>
      <Link href={RENEW_HREF} className="p-btn p-btn-dark p-btn-sm">
        Renew
      </Link>
    </div>
  );
}
