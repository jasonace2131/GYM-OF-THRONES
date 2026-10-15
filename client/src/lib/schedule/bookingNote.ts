import type { MyBooking } from '@/lib/classes';
import { waitlistClosed } from './bookingState';
import { waitlistClosesTime } from './cancelCopy';

export type BookingNoteTone = 'danger' | 'ok' | 'muted';

export interface BookingNote {
  text: string;
  tone: BookingNoteTone;
  /** A next step the member can take themselves. Null when there is none. */
  link: { label: string; href: string } | null;
}

/**
 * The one line under a booking in My bookings and in its detail sheet. It says
 * what happened to the booking, or what happens next. Null when the badge from
 * `bookingState` already says everything.
 *
 * It is pure for the same reason `bookingState` is: the copy is tested here
 * rather than in components, which have no tests.
 */
export function bookingNote(booking: MyBooking, now: Date): BookingNote | null {
  const { session } = booking;

  // A gym-cancelled class always carries a reason (ClassSession_cancel_shape).
  // The guard is for the type, not for a case that happens.
  if (session.cancelledAt !== null) {
    return note(
      session.cancelReason === null
        ? 'The gym cancelled this class.'
        : `The gym cancelled this: ${session.cancelReason}`,
      'danger',
    );
  }

  if (booking.status === 'CANCELLED') {
    if (booking.cancelledBy !== 'GYM') return null;
    // The member is shown the desk's reason (owner default, 2026-10-11): being
    // taken out of a class without a reason reads as a mistake.
    return note(
      booking.removalReason === null
        ? 'The gym took you out of this class.'
        : `The gym took you out of this class: ${booking.removalReason}`,
      'danger',
    );
  }

  if (booking.status === 'WAITLISTED') return waitlistNote(booking, now);

  if (booking.status === 'BOOKED' && booking.promotedAt !== null) {
    return note('A place opened up and you got it.', 'ok');
  }
  if (booking.status === 'BOOKED' && booking.addedByStaff) {
    return note('The desk booked this place for you.', 'muted');
  }
  return null;
}

function waitlistNote(booking: MyBooking, now: Date): BookingNote {
  const { session } = booking;

  if (new Date(session.startsAt).getTime() <= now.getTime()) {
    // "No place". True however it ended: the class stayed full, a freed seat
    // was taken by somebody else, or this member was passed over.
    return note("The waitlist didn't reach you.", 'muted');
  }

  // A free seat with this member still waiting. That happens after the cutoff,
  // or when the server passed them over at promotion. Either way, nobody moves
  // into it by themselves, and the timetable's "Take the free place" is how
  // they claim it. The server still checks their plan at that point.
  if (!session.isFull) {
    return {
      text: 'A place is free. It goes to whoever books it first.',
      tone: 'muted',
      link: {
        label: 'Take it on the timetable',
        href: `/portal/schedule?day=${session.businessDate}`,
      },
    };
  }

  if (waitlistClosed(session.startsAt, now)) {
    return note(
      'The waitlist has closed. A place that frees up now goes to whoever books it first.',
      'muted',
    );
  }

  // `== null`: an API one release behind sends no position (see bookingState).
  const when = `If a place opens up before ${waitlistClosesTime(session.startsAt, now)}, you move in automatically.`;
  return note(
    booking.waitlistPosition == null
      ? when
      : `You're #${booking.waitlistPosition} in the queue. ${when}`,
    'muted',
  );
}

function note(text: string, tone: BookingNoteTone): BookingNote {
  return { text, tone, link: null };
}
