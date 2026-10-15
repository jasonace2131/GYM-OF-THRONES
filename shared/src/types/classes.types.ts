// Classes and bookings on the wire — the one definition both runtimes read.
//
// Instants are ISO strings and civil dates are yyyy-mm-dd; nothing here is
// ever pre-formatted, because a formatted time is formatted in somebody's zone.

import type { DenialReason } from './attendance.types';

export type BookingStatus = 'BOOKED' | 'WAITLISTED' | 'CANCELLED' | 'ATTENDED' | 'NO_SHOW';

/**
 * Who cancelled a booking, as the member is told it.
 *
 * `GYM` is a desk user taking them out of the class, with a reason they can
 * read. `MEMBER` is the member themselves — including every cancellation made
 * before the system recorded who cancelled, because before staff could remove
 * anybody that was the only kind there was.
 */
export type BookingCanceller = 'MEMBER' | 'GYM';

export interface ClassSessionWire {
  id: string;
  title: string;
  description: string | null;
  coachId: string;
  coachName: string;
  startsAt: string;
  endsAt: string;
  /** yyyy-mm-dd — the gym-local day of `startsAt`, derived by the server. */
  businessDate: string;
  capacity: number;
  bookedCount: number;
  seatsLeft: number;
  isFull: boolean;
  /**
   * How many people are on the waitlist (WAITLISTED rows). Counts places, not
   * names: anybody who can see the timetable may see how long the queue is,
   * never who is in it.
   */
  waitlistCount: number;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface MyBookingWire {
  bookingId: string;
  status: BookingStatus;
  bookedAt: string;
  /**
   * Set when the member was moved off the waitlist into a seat for them — a
   * cancellation, a removal or a capacity raise freed it, or the desk moved
   * them. Null when they booked straight in, or took a freed seat themselves.
   */
  promotedAt: string | null;
  /** Set when the register marked the member present. */
  attendedAt: string | null;
  /**
   * Set when the booking was cancelled — by the member, or by the gym taking
   * them out of the class (`cancelledBy` says which). A class the GYM called
   * off is `session.cancelledAt`, and leaves the booking itself untouched.
   */
  cancelledAt: string | null;
  /**
   * 1-based place in the queue, in the order the waitlist is served (joined
   * earliest first, booking id as the tie-break). Null unless the booking is
   * WAITLISTED and the waitlist has not yet closed (`waitlistClosesAt`): after
   * that nobody is promoted, and a place number would promise a seat.
   */
  waitlistPosition: number | null;
  /** Null unless CANCELLED. */
  cancelledBy: BookingCanceller | null;
  /** The reason the desk gave when it took the member out. Null otherwise. */
  removalReason: string | null;
  /** True when the desk booked this place for the member, by hand. */
  addedByStaff: boolean;
  session: ClassSessionWire;
}

/**
 * One row of a class's register — staff only (`booking.read`). The one shape
 * for the console's and the coach's registers alike.
 *
 * Seated and marked rows (BOOKED, ATTENDED, NO_SHOW) come first in the order
 * they booked, then the waitlist in queue order — so a member marked present
 * stays where they were instead of sinking below the people still waiting.
 */
export interface ClassRegisterEntryWire {
  bookingId: string;
  status: BookingStatus;
  bookedAt: string;
  /** 1-based queue place for a WAITLISTED row; null for every other row. */
  waitlistPosition: number | null;
  /** True when the desk booked this place for the member, by hand. */
  addedByStaff: boolean;
  /**
   * When the entry was last marked, and by whom. Null on a row never marked,
   * and on entries marked before the system recorded markers. A correction
   * overwrites both: the last marker wins.
   */
  markedAt: string | null;
  markedBy: { firstName: string; lastName: string } | null;
  member: { firstName: string; lastName: string; memberCode: string | null };
}

/** What marking one register entry returns: the outcome and who recorded it. */
export interface MarkAttendanceResultWire {
  bookingId: string;
  status: 'ATTENDED' | 'NO_SHOW';
  markedAt: string;
  markedBy: { firstName: string; lastName: string };
}

/**
 * `GET /me/booking-window` — how far ahead this member may book, and whether
 * their plan lets them book at all.
 *
 * The server is the authority: the timetable sizes its date strip from
 * `windowDays` and explains a refusal BEFORE the member taps Book, but every
 * booking is still checked again on the server, on the class's own day.
 */
export interface MyBookingWindowWire {
  /** Gym days ahead, today included — 14, or 21 on a priority plan. */
  windowDays: number;
  /** yyyy-mm-dd — today + (windowDays − 1), in gym days. */
  lastBookableDay: string;
  /** Whether their plan would let them book a class today. */
  eligibleToday: boolean;
  /** Why not, when `eligibleToday` is false. */
  reason: DenialReason | null;
  /** Member copy for `reason` (`bookingRefusalCopy`); null when eligible. */
  message: string | null;
  /**
   * yyyy-mm-dd — the last gym day the plan covers, counting freezes already
   * booked in. Classes after it need a renewal. Null without a plan.
   */
  planCoversUntil: string | null;
}

/**
 * `error.details` of a BOOKING_PLAN_REQUIRED refusal. The message already says
 * it in words; these are for a screen that wants to act on it (a Renew link).
 */
export interface BookingPlanRequiredDetails {
  reason: DenialReason;
  /** yyyy-mm-dd — the day the message names, if it names one. */
  relevantDate: string | null;
}

/** `error.details` of a BOOKING_WINDOW_NOT_OPEN refusal. */
export interface BookingWindowNotOpenDetails {
  /** yyyy-mm-dd — the first gym day this member can book the class. */
  opensOn: string;
}
