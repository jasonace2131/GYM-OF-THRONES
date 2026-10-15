'use client';

import { PERMISSIONS } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import { CoachPlanPage } from '../_components/CoachPlanPage';

/**
 * `/portal/workouts/coach` — the coach's plan inside Workouts, read-only
 * (feat/workout-sessions). A static segment, so it wins over `[planId]`.
 */
export default function WorkoutsCoachPlanPage() {
  return (
    <RequirePermission permission={PERMISSIONS.WORKOUT_MEMBER}>
      <CoachPlanPage />
    </RequirePermission>
  );
}
