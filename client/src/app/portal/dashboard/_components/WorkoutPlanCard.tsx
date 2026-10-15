'use client';

import { useEffect, useState } from 'react';
import { PERMISSIONS, type WorkoutPlanView } from '@got/shared';
import { apiFetch } from '@/lib/api';
import { usePermission } from '@/components/rbac/MeProvider';
import { PlanDays } from '@/components/coaching/PlanDays';
import { Card, CardHead } from '@/components/portal/ui';

/**
 * "My workout plan" — the plan the member's coach saved, read-only
 * (feat/coach-tools, `workout.self`).
 *
 * Renders NOTHING when there is no plan, or when it could not be read: the
 * dashboard shows nothing it cannot source, and a card that says "no plan" to
 * every member without a coach would be noise on the screen they open most.
 */
export function WorkoutPlanCard({ className }: { className?: string }) {
  const allowed = usePermission(PERMISSIONS.WORKOUT_SELF);
  const [view, setView] = useState<WorkoutPlanView | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    apiFetch<{ plan: WorkoutPlanView | null }>('/me/workout-plan').then(
      (result) => {
        if (!cancelled) setView(result.plan);
      },
      () => {
        // Silent by design — see above.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  if (!allowed || view === null) return null;

  return (
    <div className={className}>
      <Card>
        <CardHead
          title="My workout plan"
          action={
            view.coach === null ? undefined : (
              <span className="p-muted" style={{ fontSize: 12.5 }}>
                From Coach {view.coach.firstName} {view.coach.lastName}
              </span>
            )
          }
        />
        <PlanDays plan={view.plan} />
      </Card>
    </div>
  );
}
