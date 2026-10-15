'use client';

import { PERMISSIONS } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import { DraftScreen } from '../_components/DraftScreen';

/** `/portal/workouts/draft` — generating, then the draft to save. */
export default function DraftPage() {
  return (
    <RequirePermission permission={PERMISSIONS.WORKOUT_MEMBER}>
      <DraftScreen />
    </RequirePermission>
  );
}
