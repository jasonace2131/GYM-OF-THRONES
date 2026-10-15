import type { MyCheckInSummary } from '@got/shared';
import { apiFetch } from '@/lib/api';
import { classesApi } from '@/lib/classes';
import { GYM_TIMEZONE, gymToday } from '@/lib/gymTime';
import {
  toHeatmap,
  type AccessResult,
  type CheckInDay,
  type MembershipDetail,
} from '@/lib/portalData';
import { shiftDay } from '@/lib/schedule/gymClock';
import { summariseUpcoming, type UpcomingSummary } from '@/lib/schedule/upcoming';
import { UPCOMING_DAYS } from './dashboardView';

/**
 * The dashboard's data — three calls, each failing on its own.
 *
 * `GET /me/overview` answers the name AND the plan AND the verdict in one
 * read; the screen this replaces paid for `/me` and `/me/membership`
 * separately. Announcements are not here at all: they come from the shared
 * feed (`AnnouncementsProvider`), so the bell and the dashboard fetch once.
 *
 * THE OVERVIEW IS THE PAGE. Without it there is no name and no plan, so its
 * failure rejects and the page shows its error. The summary and the bookings
 * are SECTIONS: each failure is carried as `{ ok: false }` and that section
 * alone offers "Try again" — a slow bookings call must not blank the status
 * band a member opened the app to read.
 */

/** The fields of `GET /me/overview` this screen reads. */
export interface MemberOverview {
  firstName: string;
  membership: MembershipDetail | null;
  verdict: AccessResult;
}

export type Section<T> = { ok: true; data: T } | { ok: false };

export interface CheckInSection {
  summary: MyCheckInSummary;
  heatmap: CheckInDay[];
}

export interface DashboardData {
  overview: MemberOverview;
  checkIns: Section<CheckInSection>;
  bookings: Section<UpcomingSummary>;
}

export async function loadDashboard(now: Date): Promise<DashboardData> {
  const [overview, checkIns, bookings] = await Promise.allSettled([
    apiFetch<MemberOverview>('/me/overview'),
    loadCheckIns(),
    loadUpcoming(now),
  ]);

  if (overview.status === 'rejected') throw overview.reason;

  return {
    overview: overview.value,
    checkIns: settle(checkIns),
    bookings: settle(bookings),
  };
}

/** The counters, the streak and the heatmap — one call, one section. */
export async function loadCheckIns(): Promise<CheckInSection> {
  const summary = await apiFetch<MyCheckInSummary>('/me/check-ins/summary');
  return { summary, heatmap: toHeatmap(summary) };
}

/**
 * The member's live bookings over exactly `UPCOMING_DAYS` gym days, today
 * included. `to` is inclusive on the server, so the last day is today + 13.
 */
export async function loadUpcoming(now: Date): Promise<UpcomingSummary> {
  const today = gymToday(now, GYM_TIMEZONE);
  const bookings = await classesApi.myBookings({
    from: today,
    to: shiftDay(today, UPCOMING_DAYS - 1),
  });
  return summariseUpcoming(bookings, now);
}

function settle<T>(result: PromiseSettledResult<T>): Section<T> {
  return result.status === 'fulfilled' ? { ok: true, data: result.value } : { ok: false };
}
