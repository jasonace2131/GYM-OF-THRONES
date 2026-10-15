'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { PERMISSIONS } from '@got/shared';
import { Skeleton } from '@/components/portal/ui';
import { RequirePermission } from '@/components/rbac/guards';
import { SummaryPage } from '../../_components/SummaryPage';

/**
 * `/portal/workouts/history/[sessionId]` — one finished workout; `?just=1`
 * is the "Workout done" screen straight after Finish.
 *
 * The `<Suspense>` is load-bearing: `SummaryPage` reads `?just=` with
 * `useSearchParams`, which must sit under a Suspense boundary or
 * `next build` fails.
 */
export default function WorkoutSummaryPage() {
  // Keyed by id: another summary is another page, with none of this one's state.
  const { sessionId } = useParams<{ sessionId: string }>();
  return (
    <RequirePermission permission={PERMISSIONS.WORKOUT_MEMBER}>
      <Suspense
        fallback={
          <div className="grid gap-5" aria-busy="true">
            <Skeleton height={60} />
            <Skeleton height={180} />
          </div>
        }
      >
        <SummaryPage key={sessionId} />
      </Suspense>
    </RequirePermission>
  );
}
