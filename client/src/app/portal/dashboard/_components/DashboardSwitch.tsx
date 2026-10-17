'use client';

import { useMe } from '@/components/rbac/MeProvider';
import { isCoach } from '@/lib/safeNext';
import { CoachDashboard } from './CoachDashboard';
import { Dashboard } from './Dashboard';
import { DashboardSkeleton } from './DashboardSkeleton';

/**
 * One Dashboard row, two dashboards behind it (owner, 2026-10-06).
 *
 * A coach sees their coaching view; everybody else, and staff
 * visiting the portal — sees the member dashboard. Decided by `isCoach`, the
 * same permission test (`coach.read` held by somebody who is not staff) that
 * sends a coach here after sign-in, so the landing page and what it shows can
 * never disagree. Not a role check, for the reason `isStaff` gives.
 *
 * While `/me` is in flight neither is mounted: rendering the member dashboard
 * first would fire its member-only requests for a coach and flash "No active
 * plan" before swapping.
 */
export function DashboardSwitch() {
  const { status, me } = useMe();
  if (status === 'loading' && me === null) return <DashboardSkeleton />;
  return isCoach(me?.permissions ?? null) ? <CoachDashboard /> : <Dashboard />;
}
