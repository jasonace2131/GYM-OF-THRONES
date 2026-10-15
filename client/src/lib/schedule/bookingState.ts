import { waitlistClosesAt } from '@got/shared';
import type { ClassSession, MyBooking } from '@/lib/classes';

export type BookingTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';
export type BookingDot = 'booked' | 'waitlist' | 'attended' | 'other';

export interface BookingView {
  label: string;
  tone: BookingTone;
  canCancel: boolean;
  dot: BookingDot;
  /**
   * Still ahead and still the member's: a seat, or a waitlist place, before the
   * class starts. It draws the gold "mine" frame on the timetable and puts the
   * row on the dashboard's Upcoming list. The "Booked" tile counts only the
   * seats among these rows (`summariseUpcoming`).
   */
  live: boolean;
}

/** The fields a label depends on. Every screen passes the whole booking. */
export type BookingStateInput = Pick<
  MyBooking,
  'status' | 'session' | 'waitlistPosition' | 'cancelledBy'
>;

/**
 * Whether a class's waitlist has closed (owner, 2026-10-11): from
 * `waitlistClosesAt` on, nobody joins it and nobody is promoted from it. It is
 * the shared constant the server refuses on, so the label and the refusal can
 * only disagree by the gap between this device's clock and the server's.
 */
export function waitlistClosed(startsAt: string, now: Date): boolean {
  return waitlistClosesAt(startsAt).getTime() <= now.getTime();
}

/**
 * How many people are waiting for a class, while that number still means
 * something. Null once the class has started (a waitlist place it never
 * reached reads "No place"), on a class the gym called off, and when nobody
 * is waiting. It counts places, never names. The timetable card and the
 * booking's detail sheet both read it, so the two cannot disagree.
 */
export function waitingCount(
  session: Pick<ClassSession, 'startsAt' | 'cancelledAt' | 'waitlistCount'>,
  now: Date,
): number | null {
  if (session.cancelledAt !== null) return null;
  if (new Date(session.startsAt).getTime() <= now.getTime()) return null;
  return session.waitlistCount > 0 ? session.waitlistCount : null;
}

/**
 * The only place a booking's label is decided (spec §5.3).
 *
 * Placement on a screen ("On now" / "Coming up" / "Past") is by time, in
 * `groupBookings`; the label is from here. A started BOOKED row has its own
 * label ("Not marked"), and so does a started WAITLISTED one ("No place"), so
 * the two can never contradict each other.
 *
 * A waitlist place has three phases (owner, 2026-10-11):
 *   - until the cutoff: "Waitlist · #2". The server moves the member in by
 *     itself when a seat frees.
 *   - from the cutoff to the start: "Waitlist closed". Nobody is moved in any
 *     more, but the member may still leave, or take a freed seat themselves.
 *   - from the start: "No place". The waitlist never reached them. This is
 *     display only; the row stays WAITLISTED on the server.
 */
export function bookingState(booking: BookingStateInput, now: Date): BookingView {
  const started = new Date(booking.session.startsAt).getTime() <= now.getTime();

  if (booking.session.cancelledAt !== null) {
    return {
      label: 'Class cancelled',
      tone: 'danger',
      canCancel: false,
      dot: 'other',
      live: false,
    };
  }

  switch (booking.status) {
    case 'CANCELLED':
      // The desk taking a member out is not the member's own doing. It must
      // never read as "You cancelled" (F9).
      return booking.cancelledBy === 'GYM'
        ? {
            label: 'Removed by the gym',
            tone: 'danger',
            canCancel: false,
            dot: 'other',
            live: false,
          }
        : { label: 'You cancelled', tone: 'neutral', canCancel: false, dot: 'other', live: false };
    case 'WAITLISTED':
      if (started) {
        // 'other', not 'waitlist': a place the waitlist never reached must not
        // outrank an attended class in the same day's dot (dayMarks).
        return { label: 'No place', tone: 'neutral', canCancel: false, dot: 'other', live: false };
      }
      if (waitlistClosed(booking.session.startsAt, now)) {
        return {
          label: 'Waitlist closed',
          tone: 'neutral',
          canCancel: true,
          dot: 'waitlist',
          live: true,
        };
      }
      return {
        // The server sends a position only while the waitlist is open. A row
        // without one still says what it is rather than inventing a number.
        // `== null` on purpose: an API one release behind sends no field at
        // all, and `classes.ts` filling it in is the first lock, not the only.
        label:
          booking.waitlistPosition == null ? 'Waitlist' : `Waitlist · #${booking.waitlistPosition}`,
        tone: 'warn',
        canCancel: true,
        dot: 'waitlist',
        live: true,
      };
    case 'BOOKED':
      return started
        ? { label: 'Not marked', tone: 'neutral', canCancel: false, dot: 'other', live: false }
        : { label: 'Booked', tone: 'ok', canCancel: true, dot: 'booked', live: true };
    case 'ATTENDED':
      return { label: 'Attended', tone: 'info', canCancel: false, dot: 'attended', live: false };
    case 'NO_SHOW':
      return { label: 'Missed', tone: 'danger', canCancel: false, dot: 'other', live: false };
  }
}

/** A member with any non-cancelled row holds the class, so Book is never offered. */
export function holdsPlace(booking: Pick<MyBooking, 'status'>): boolean {
  return booking.status !== 'CANCELLED';
}

const PRIORITY: Record<BookingDot, number> = { booked: 0, waitlist: 1, attended: 2, other: 3 };

/** One dot per gym day, from that day's most relevant booking. */
export function dayMarks(bookings: readonly MyBooking[], now: Date): Map<string, BookingDot> {
  const marks = new Map<string, BookingDot>();
  for (const item of bookings) {
    const dot = bookingState(item, now).dot;
    const day = item.session.businessDate;
    const current = marks.get(day);
    if (current === undefined || PRIORITY[dot] < PRIORITY[current]) marks.set(day, dot);
  }
  return marks;
}
