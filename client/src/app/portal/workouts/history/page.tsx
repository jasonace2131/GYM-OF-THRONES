'use client';

import { PERMISSIONS } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import { HistoryPage } from '../_components/HistoryPage';

/** `/portal/workouts/history` — finished workouts (feat/workout-sessions). */
export default function WorkoutHistoryPage() {
  return (
    <RequirePermission permission={PERMISSIONS.WORKOUT_MEMBER}>
      <HistoryPage />
    </RequirePermission>
  );
}
