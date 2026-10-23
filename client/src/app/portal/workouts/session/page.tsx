'use client';

import { PERMISSIONS } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import { WritesOnly } from '@/components/portal/MembershipGate';
import { SessionScreen } from '@/components/workouts/session/SessionScreen';

/**
 * `/portal/workouts/session` — the open workout, full screen
 * (feat/workout-sessions, PhoneSession.dc.html). There is at most one open
 * workout per member, so the route needs no id: the server says which.
 */
export default function WorkoutSessionPage() {
  return (
    <RequirePermission permission={PERMISSIONS.WORKOUT_MEMBER}>
      {/* Logging sets is a write: a lapsed member is pointed back. */}
      <WritesOnly backHref="/portal/workouts/history" backLabel="See past workouts">
        <SessionScreen />
      </WritesOnly>
    </RequirePermission>
  );
}
