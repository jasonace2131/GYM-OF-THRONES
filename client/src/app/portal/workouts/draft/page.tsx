'use client';

import { PERMISSIONS } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import { WritesOnly } from '@/components/portal/MembershipGate';
import { DraftScreen } from '../_components/DraftScreen';

/** `/portal/workouts/draft` — generating, then the draft to save. */
export default function DraftPage() {
  return (
    <RequirePermission permission={PERMISSIONS.WORKOUT_MEMBER}>
      {/* A draft is a write in progress: a lapsed member is pointed back. */}
      <WritesOnly backHref="/portal/workouts" backLabel="Back to Workouts">
        <DraftScreen />
      </WritesOnly>
    </RequirePermission>
  );
}
