import type {
  BookingStatus,
  ClassSessionWire,
  MyBookingWindowWire,
  MyBookingWire,
} from '@got/shared';
import { apiFetch } from './api';

/**
 * Classes and bookings, client side.
 *
 * Every instant arrives as an ISO string and is formatted HERE with an
 * explicit gym time zone — a member on a phone set to Singapore must see the
 * times the gym runs on, not the times their handset thinks it is.
 */

/** Declared in `gymTime.ts` (a leaf) and re-exported here for its old callers. */
export { GYM_TIMEZONE } from './gymTime';
import { GYM_TIMEZONE } from './gymTime';

/** The wire types live in @got/shared so the server and this file cannot drift. */
export type ClassSession = ClassSessionWire;
export type MyBooking = MyBookingWire;
export type MyBookingWindow = MyBookingWindowWire;
export type { BookingStatus };

/**
 * A class as an API one release behind sends it: without `waitlistCount`.
 *
 * The client deploys minutes before the API does, and in that gap the new
 * screens read the old replies. A missing field read as-is prints
 * "Waitlist · #undefined" and "NaN waiting", so every reply passes through the
 * normalisers below and the screens always see the whole shape.
 */
export type OlderClassSession = Omit<ClassSession, 'waitlistCount'> &
  Partial<Pick<ClassSession, 'waitlistCount'>>;

type AddedBookingField = 'waitlistPosition' | 'cancelledBy' | 'removalReason' | 'addedByStaff';

/** A booking as an API one release behind sends it (see `OlderClassSession`). */
export type OlderMyBooking = Omit<MyBooking, AddedBookingField | 'session'> &
  Partial<Pick<MyBooking, AddedBookingField>> & { session: OlderClassSession };

/** Fills what an older API leaves out: nobody is counted as waiting. */
export function normaliseSession(raw: OlderClassSession): ClassSession {
  return { ...raw, waitlistCount: raw.waitlistCount ?? 0 };
}

/**
 * Fills what an older API leaves out with the values that claim nothing: no
 * queue place, not the desk's doing. A cancellation it sends is the member's
 * own, because the old API has no route for staff to take anybody out
 * (`cancelledBy` is null unless CANCELLED, as on the new wire).
 */
export function normaliseBooking(raw: OlderMyBooking): MyBooking {
  return {
    ...raw,
    waitlistPosition: raw.waitlistPosition ?? null,
    cancelledBy: raw.cancelledBy ?? (raw.status === 'CANCELLED' ? 'MEMBER' : null),
    removalReason: raw.removalReason ?? null,
    addedByStaff: raw.addedByStaff ?? false,
    session: normaliseSession(raw.session),
  };
}

export const classesApi = {
  sessions: async (params: { from?: string; to?: string } = {}): Promise<ClassSession[]> => {
    const query = new URLSearchParams(
      Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ).toString();
    const list = await apiFetch<OlderClassSession[]>(
      `/class-sessions${query === '' ? '' : `?${query}`}`,
    );
    return list.map(normaliseSession);
  },

  /** A window of gym days; the server defaults to 60 days either side of today. */
  myBookings: async (params: { from?: string; to?: string } = {}): Promise<MyBooking[]> => {
    const query = new URLSearchParams(
      Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ).toString();
    const list = await apiFetch<OlderMyBooking[]>(`/me/bookings${query === '' ? '' : `?${query}`}`);
    return list.map(normaliseBooking);
  },

  /**
   * How far ahead the caller may book, and whether their plan lets them book
   * today. The timetable sizes its date strip from this and explains a refusal
   * before the member taps Book. Every booking is still checked on the server.
   */
  bookingWindow: (): Promise<MyBookingWindow> => apiFetch<MyBookingWindow>('/me/booking-window'),

  /**
   * Books a seat, joins the waitlist when the class is full, or takes a freed
   * seat for a member who is already waiting. The status in the reply says
   * which. A refusal (plan, window, closed waitlist) is thrown as an ApiError
   * whose message is member copy.
   */
  book: async (sessionId: string): Promise<MyBooking> =>
    normaliseBooking(
      await apiFetch<OlderMyBooking>(`/class-sessions/${sessionId}/bookings`, { method: 'POST' }),
    ),

  cancel: async (sessionId: string): Promise<MyBooking> =>
    normaliseBooking(
      await apiFetch<OlderMyBooking>(`/class-sessions/${sessionId}/bookings`, {
        method: 'DELETE',
      }),
    ),
};

/** `6:30 PM`, gym-local. Members read a clock, not a timetable. */
export function classTime(iso: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: GYM_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

/** `Mon 26 Aug`, gym-local. */
export function classDay(iso: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: GYM_TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
}

/** `45 min`. Duration is a difference between instants, so no zone applies. */
export function classLength(startsAt: string, endsAt: string): string {
  const minutes = Math.round((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * Groups a flat list into gym-local days, preserving order.
 *
 * Grouped on `businessDate` — which the SERVER derived from the class's start
 * in the gym's zone — rather than re-deriving it here. Two implementations of
 * "which day is this" is how a 06:00 class ends up under yesterday on one
 * screen and today on another.
 */
export function groupByDay(sessions: readonly ClassSession[]): {
  date: string;
  label: string;
  sessions: ClassSession[];
}[] {
  const days = new Map<string, ClassSession[]>();
  for (const session of sessions) {
    const list = days.get(session.businessDate);
    if (list === undefined) days.set(session.businessDate, [session]);
    else list.push(session);
  }

  return [...days.entries()].map(([date, list]) => ({
    date,
    // Formatted from the civil date at UTC — it IS a civil date, so applying a
    // zone to it would shift it.
    label: new Intl.DateTimeFormat('en-PH', {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'short',
    }).format(new Date(`${date}T00:00:00.000Z`)),
    sessions: list,
  }));
}
