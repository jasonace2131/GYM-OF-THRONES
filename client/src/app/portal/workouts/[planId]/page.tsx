'use client';

import { Suspense } from 'react';
import { PERMISSIONS } from '@got/shared';
import { Skeleton } from '@/components/portal/ui';
import { RequirePermission } from '@/components/rbac/guards';
import { PlanPage } from '../_components/PlanPage';

/**
 * `/portal/workouts/[planId]` — one saved plan.
 *
 * The `<Suspense>` is load-bearing: `PlanPage` reads `?adjust=` with
 * `useSearchParams`, which must sit under a Suspense boundary in a
 * prerendered route or `next build` fails.
 */
export default function WorkoutPlanPage() {
  return (
    <RequirePermission permission={PERMISSIONS.WORKOUT_MEMBER}>
      <Suspense
        fallback={
          <div className="grid gap-5" aria-busy="true">
            <Skeleton height={60} />
            <Skeleton height={160} />
            <Skeleton height={420} />
          </div>
        }
      >
        <PlanPage />
      </Suspense>
    </RequirePermission>
  );
}
