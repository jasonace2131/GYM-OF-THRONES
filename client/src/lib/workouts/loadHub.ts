import type { MyBookingWire, MyCheckInSummary, WorkoutsHome } from '@got/shared';
import { apiFetch } from '@/lib/api';
import { classesApi } from '@/lib/classes';
import { GYM_TIMEZONE, addDays, gymToday, type CivilDate } from '@/lib/gymTime';
import { workoutsApi } from './api';

/**
 * The hub's data — `GET /me/workouts` is the page; the check-in summary and
 * this week's bookings are SECTIONS that fail on their own (the strip then
 * shows no tick and no class, and says nothing false).
 */
export interface HubData {
  today: CivilDate;
  home: WorkoutsHome;
  checkIns: MyCheckInSummary | null;
  bookings: MyBookingWire[];
}

function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay();
}

/** Monday..Sunday of the gym week that holds `today`. */
export function gymWeek(today: CivilDate): { from: CivilDate; to: CivilDate } {
  const weekday = weekdayOf(today);
  const from = addDays(today, weekday === 0 ? -6 : 1 - weekday);
  return { from, to: addDays(from, 6) };
}

export async function loadWeekBookings(today: CivilDate): Promise<MyBookingWire[]> {
  const week = gymWeek(today);
  return classesApi.myBookings({ from: week.from, to: week.to });
}

export async function loadHub(now: Date): Promise<HubData> {
  const today = gymToday(now, GYM_TIMEZONE);
  const [home, checkIns, bookings] = await Promise.allSettled([
    workoutsApi.home(),
    apiFetch<MyCheckInSummary>('/me/check-ins/summary'),
    loadWeekBookings(today),
  ]);
  if (home.status === 'rejected') throw home.reason;
  return {
    today,
    home: home.value,
    checkIns: checkIns.status === 'fulfilled' ? checkIns.value : null,
    bookings: bookings.status === 'fulfilled' ? bookings.value : [],
  };
}
