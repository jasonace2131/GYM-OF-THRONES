'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnnouncementsSection } from '@/components/announcements/AnnouncementsSection';
import { PinnedNoticeBanner } from '@/components/announcements/PinnedNoticeBanner';
import { parseNoticeFocus } from '@/lib/announcements/focus';
import {
  greeting,
  nextUpParts,
  statTiles,
  streakLabel,
  upcomingEmptyHint,
} from '@/lib/dashboard/dashboardView';
import {
  loadCheckIns,
  loadDashboard,
  loadUpcoming,
  type DashboardData,
} from '@/lib/dashboard/loadDashboard';
import { membershipStatusView, withoutSelfService } from '@/lib/dashboard/membershipStatus';
import { PERMISSIONS } from '@got/shared';
import { usePermission } from '@/components/rbac/MeProvider';
import { ConsistencyCard } from './ConsistencyCard';
import { DashboardError } from './DashboardError';
import { DashboardSkeleton } from './DashboardSkeleton';
import { StatsRow } from './StatsRow';
import { StatusBand } from './StatusBand';
import { TodayWorkoutCard } from './TodayWorkoutCard';
import { UpcomingCard } from './UpcomingCard';
import { WorkoutPlanCard } from './WorkoutPlanCard';

/**
 * The member dashboard.
 *
 * Loaded ONCE on mount. `?notice=` is read with `useSearchParams`, and a
 * change to only the search params does not remount this page — so a bell
 * row clicked while the member is already here expands the notice in place,
 * with no refetch and no skeleton flash.
 *
 * LAYOUT is a container query, not a viewport one: the portal's content
 * column is narrower than the window (a 244px sidebar on desktop), and the
 * two-column arrangement should follow the space it actually has. From
 * `@3xl` the noticeboard takes the right column beside upcoming and
 * consistency; below it everything stacks in reading order, with the newest
 * pinned notice lifted above the status band.
 *
 * No member code card (owner, 2026-10-06): the front desk has no camera to
 * scan one, so "Can't scan? Show my code instead" offered a way in that did
 * not exist. Members scan the counter; the desk can still type a code.
 */
export function Dashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focus = parseNoticeFocus(searchParams.get('notice'));

  const [data, setData] = useState<DashboardData | null>(null);
  const [failed, setFailed] = useState(false);
  // Coaches and staff have no My Subscription (membership.self is CLIENT-only),
  // so the band must not offer them a button into it.
  const canSelfServe = usePermission(PERMISSIONS.MEMBERSHIP_SELF);

  const load = useCallback((): void => {
    setFailed(false);
    loadDashboard(new Date())
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const retryCheckIns = useCallback((): void => {
    loadCheckIns()
      .then((next) => setData((prev) => prev && { ...prev, checkIns: { ok: true, data: next } }))
      .catch(() => undefined);
  }, []);

  const retryBookings = useCallback((): void => {
    loadUpcoming(new Date())
      .then((next) => setData((prev) => prev && { ...prev, bookings: { ok: true, data: next } }))
      .catch(() => undefined);
  }, []);

  // The deep link has been acted on: drop it, without scrolling to the top.
  const clearFocus = useCallback((): void => {
    router.replace('/portal/dashboard', { scroll: false });
  }, [router]);

  if (failed) return <DashboardError onRetry={load} />;
  if (data === null) return <DashboardSkeleton />;

  const now = new Date();
  const { overview, checkIns, bookings } = data;
  const view = withoutSelfService(
    membershipStatusView(overview.membership, overview.verdict),
    canSelfServe,
  );
  const next = bookings.ok ? bookings.data.next : null;

  return (
    <div className="@container">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <PinnedNoticeBanner className="@3xl:hidden" />

        <StatusBand
          greeting={greeting(now)}
          firstName={overview.firstName}
          view={view}
          streak={checkIns.ok ? streakLabel(checkIns.data.summary.currentStreakWeeks) : null}
          nextUp={next === null ? null : nextUpParts(next, now)}
        />

        {/* Seats only: a waitlist place is not a booking yet, so the Upcoming
            card counts those separately. */}
        <StatsRow
          tiles={statTiles(
            checkIns.ok ? checkIns.data.summary : null,
            bookings.ok ? bookings.data.booked : null,
          )}
        />

        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 @3xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] @3xl:grid-rows-[auto_1fr] @3xl:[grid-template-areas:'upcoming_notices''consistency_notices']">
          {/* Whether, and how far ahead, this member can book: from the plan
              and the verdict /me/overview already returned. A plan that does
              not cover today books nothing (owner, 2026-10-11). No extra call
              for one sentence of copy. */}
          <UpcomingCard
            bookings={bookings}
            now={now}
            emptyHint={upcomingEmptyHint(overview.membership, overview.verdict, now)}
            onRetry={retryBookings}
            className="@3xl:[grid-area:upcoming]"
          />
          <AnnouncementsSection
            focus={focus}
            onFocusHandled={clearFocus}
            className="@3xl:[grid-area:notices]"
          />
          <ConsistencyCard
            checkIns={checkIns}
            cta={view.primaryCta}
            onRetry={retryCheckIns}
            className="@3xl:[grid-area:consistency]"
          />
        </div>

        {/* feat/coach-tools: the plan the member's coach saved. Renders
            nothing without one. */}
        <WorkoutPlanCard />

        {/* feat/member-workouts: today's session from the member's own active
            AI plan. The coach's card stays first; this renders nothing without
            an active plan. */}
        <TodayWorkoutCard />
      </div>
    </div>
  );
}
