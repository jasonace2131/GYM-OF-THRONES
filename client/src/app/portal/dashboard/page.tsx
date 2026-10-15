import { Suspense } from 'react';
import { DashboardSkeleton } from './_components/DashboardSkeleton';
import { DashboardSwitch } from './_components/DashboardSwitch';

/**
 * `/portal/dashboard` — the member dashboard, or the coach's for a coach (see
 * `DashboardSwitch`).
 *
 * The `<Suspense>` is load-bearing: both dashboards read `?notice=` with
 * `useSearchParams`, and in a prerendered route that hook must sit under a
 * Suspense boundary or `next build` fails. The fallback is the same skeleton
 * the page shows while its data loads, so the two phases look like one.
 */
export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardSwitch />
    </Suspense>
  );
}
