'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PERMISSIONS, type WorkoutsHome } from '@got/shared';
import { usePermission } from '@/components/rbac/MeProvider';
import { Card, CardHead } from '@/components/portal/ui';
import { IconDumbbell } from '@/components/portal/icons';
import { GYM_TIMEZONE, gymToday } from '@/lib/gymTime';
import { workoutsApi } from '@/lib/workouts/api';
import { dashboardCard, todayModel } from '@/lib/workouts/today';

/**
 * Today's workout on the dashboard (feat/member-workouts, feat/workout-sessions):
 * the day from the member's active AI plan, else from their coach's plan, or
 * the workout they have open ("Continue"), or the one they finished today
 * ("View summary"). Renders NOTHING when there is nothing to show or the read
 * failed: like `WorkoutPlanCard`, the dashboard shows nothing it cannot source.
 */
export function TodayWorkoutCard({ className }: { className?: string }) {
  const allowed = usePermission(PERMISSIONS.WORKOUT_MEMBER);
  const [home, setHome] = useState<WorkoutsHome | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    workoutsApi.home().then(
      (next) => {
        if (!cancelled) setHome(next);
      },
      () => {
        // Silent by design — see above.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  if (!allowed || home === null) return null;
  const copy = dashboardCard(todayModel(home, gymToday(new Date(), GYM_TIMEZONE)));
  if (copy === null) return null;

  return (
    <div className={className}>
      <Card>
        <CardHead
          title={copy.heading}
          action={
            <span className="p-muted" style={{ fontSize: 12.5 }}>
              {copy.planLabel}
            </span>
          }
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 14,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700 }}>
              {copy.title}
            </span>
            <span className="p-muted" style={{ fontSize: 13 }}>
              {copy.meta}
            </span>
          </div>
          <Link href={copy.href} className="p-btn p-btn-gold p-btn-sm">
            <IconDumbbell size={16} />
            {copy.cta}
          </Link>
        </div>
      </Card>
    </div>
  );
}
