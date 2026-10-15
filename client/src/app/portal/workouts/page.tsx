'use client';

import { PERMISSIONS } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import { WorkoutsHub } from './_components/WorkoutsHub';

/**
 * `/portal/workouts` — the member's AI workout planner (feat/member-workouts).
 *
 * A member's own section: `workout.member`, which only CLIENT holds. The
 * guard is the same one every other member section uses; the routes behind
 * it are permission-checked server-side regardless.
 */
export default function WorkoutsPage() {
  return (
    <RequirePermission permission={PERMISSIONS.WORKOUT_MEMBER}>
      <WorkoutsHub />
    </RequirePermission>
  );
}
