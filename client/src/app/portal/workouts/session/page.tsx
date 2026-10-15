'use client';

import { PERMISSIONS } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import { SessionScreen } from '@/components/workouts/session/SessionScreen';

/**
 * `/portal/workouts/session` — the open workout, full screen
 * (feat/workout-sessions, PhoneSession.dc.html). There is at most one open
 * workout per member, so the route needs no id: the server says which.
 */
export default function WorkoutSessionPage() {
  return (
    <RequirePermission permission={PERMISSIONS.WORKOUT_MEMBER}>
      <SessionScreen />
    </RequirePermission>
  );
}
