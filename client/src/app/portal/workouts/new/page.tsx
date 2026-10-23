'use client';

import { Suspense } from 'react';
import { PERMISSIONS } from '@got/shared';
import { Skeleton } from '@/components/portal/ui';
import { RequirePermission } from '@/components/rbac/guards';
import { WritesOnly } from '@/components/portal/MembershipGate';
import { IntakeWizard } from '../_components/IntakeWizard';

/**
 * `/portal/workouts/new` — the intake wizard.
 *
 * The `<Suspense>` is load-bearing: `IntakeWizard` reads `?from=` with
 * `useSearchParams`, and in a prerendered route that hook must sit under a
 * Suspense boundary or `next build` fails.
 */
export default function NewWorkoutPage() {
  return (
    <RequirePermission permission={PERMISSIONS.WORKOUT_MEMBER}>
      {/* Generating a plan spends AI: a lapsed member is pointed back. */}
      <WritesOnly backHref="/portal/workouts" backLabel="Back to Workouts">
        <Suspense
          fallback={
            <div className="grid gap-5" aria-busy="true">
              <Skeleton height={60} />
              <Skeleton height={420} />
            </div>
          }
        >
          <IntakeWizard />
        </Suspense>
      </WritesOnly>
    </RequirePermission>
  );
}
