'use client';

import { Suspense } from 'react';
import { Card } from '@/components/portal/ui';
import { MembersRoster } from './MembersRoster';

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THIS FILE EXISTS TO HOLD A `<Suspense>` BOUNDARY. THAT IS ITS WHOLE JOB.
 *
 * `MembersRoster` calls `useSearchParams()` — it has to, because the
 * dashboard's attention rail links in with `?standing=EXPIRING&sort=ending`
 * and the nightly job's stored notifications link in with `?sort=ending`.
 *
 * A client component that reads `useSearchParams()` and is NOT inside a
 * Suspense boundary makes `next build` fail its prerender pass, while
 * `next dev` renders it perfectly happily — so the failure only ever appears
 * on the deploy. No other admin screen uses `useSearchParams`, so there is no
 * in-repo precedent to copy and nothing else would have caught it.
 *
 * Keep the body in `MembersRoster.tsx`. Moving it back up here re-creates the
 * bug in a form that passes every local check.
 * ─────────────────────────────────────────────────────────────────────────
 */
export default function AdminMembersPage() {
  return (
    <Suspense
      fallback={
        <Card>
          <p className="p-muted">Loading members…</p>
        </Card>
      }
    >
      <MembersRoster />
    </Suspense>
  );
}
