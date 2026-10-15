import type { MyBooking } from '@/lib/classes';
import { bookingState } from './bookingState';

export interface UpcomingSummary {
  /** The earliest live BOOKED class. A waitlist place is not "next up". */
  next: MyBooking | null;
  /** The soonest live rows, seats and waitlist places alike, each with its own badge. */
  upcoming: MyBooking[];
  /**
   * Live seats: BOOKED and not started. This is what the "Booked" tile counts.
   * A waitlist place is not a booking yet, and counting one there would
   * promise a class the member may never get into.
   */
  booked: number;
  /** Live waitlist places, counted apart so that they never inflate `booked`. */
  waitlisted: number;
}

export function summariseUpcoming(
  bookings: readonly MyBooking[],
  now: Date,
  limit = 3,
): UpcomingSummary {
  const live = bookings
    .filter((item) => bookingState(item, now).live)
    .sort((a, b) => a.session.startsAt.localeCompare(b.session.startsAt));

  return {
    next: live.find((item) => item.status === 'BOOKED') ?? null,
    upcoming: live.slice(0, limit),
    booked: live.filter((item) => item.status === 'BOOKED').length,
    waitlisted: live.filter((item) => item.status === 'WAITLISTED').length,
  };
}
