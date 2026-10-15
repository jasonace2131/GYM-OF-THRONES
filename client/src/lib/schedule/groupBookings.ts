import type { MyBooking } from '@/lib/classes';

export interface BookingGroups {
  /** Running right now: started, not yet ended. Soonest start first. */
  onNow: MyBooking[];
  /** Not started yet. Soonest first. */
  comingUp: MyBooking[];
  /** Ended. Most recent first. */
  past: MyBooking[];
}

/**
 * My bookings' List view, split by time alone.
 *
 * The old split was on start time: "Coming up" or "Been to". A class running
 * now was listed as already "been to", and so was every place the member had
 * cancelled, missed or never got. Now a class is "On now" from its start until
 * its end, and "Past" only once it has ended. Every status stays in its time
 * group; the badge from `bookingState` says what became of the booking, so the
 * placement and the label cannot contradict each other.
 */
export function groupBookings(bookings: readonly MyBooking[], now: Date): BookingGroups {
  const at = now.getTime();
  const onNow: MyBooking[] = [];
  const comingUp: MyBooking[] = [];
  const past: MyBooking[] = [];

  for (const item of bookings) {
    if (new Date(item.session.startsAt).getTime() > at) comingUp.push(item);
    else if (new Date(item.session.endsAt).getTime() > at) onNow.push(item);
    else past.push(item);
  }

  const soonest = (a: MyBooking, b: MyBooking): number =>
    a.session.startsAt.localeCompare(b.session.startsAt);

  return {
    onNow: onNow.sort(soonest),
    comingUp: comingUp.sort(soonest),
    past: past.sort((a, b) => soonest(b, a)),
  };
}
