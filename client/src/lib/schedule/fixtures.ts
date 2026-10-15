import type { BookingStatus, ClassSession, MyBooking } from '@/lib/classes';

/** Wed 16 Sep 2026, 6:00 PM Manila, one hour. */
export function session(over: Partial<ClassSession> = {}): ClassSession {
  return {
    id: 's1',
    title: 'Yoga',
    description: null,
    coachId: 'c1',
    coachName: 'Coach Andrea',
    startsAt: '2026-09-16T10:00:00.000Z',
    endsAt: '2026-09-16T11:00:00.000Z',
    businessDate: '2026-09-16',
    capacity: 16,
    bookedCount: 2,
    seatsLeft: 14,
    isFull: false,
    waitlistCount: 0,
    cancelledAt: null,
    cancelReason: null,
    ...over,
  };
}

/**
 * A booking as the server sends it for `status`: a WAITLISTED one is first in
 * the queue and a CANCELLED one was the member's own doing, unless `fields`
 * says otherwise (a later place, a closed waitlist, a removal by the gym).
 */
export function booking(
  status: BookingStatus,
  over: Partial<ClassSession> = {},
  id = 'b1',
  fields: Partial<Omit<MyBooking, 'bookingId' | 'status' | 'session'>> = {},
): MyBooking {
  return {
    bookingId: id,
    status,
    bookedAt: '2026-09-10T02:00:00.000Z',
    promotedAt: null,
    attendedAt: status === 'ATTENDED' ? '2026-09-16T10:05:00.000Z' : null,
    cancelledAt: status === 'CANCELLED' ? '2026-09-12T02:00:00.000Z' : null,
    waitlistPosition: status === 'WAITLISTED' ? 1 : null,
    cancelledBy: status === 'CANCELLED' ? 'MEMBER' : null,
    removalReason: null,
    addedByStaff: false,
    ...fields,
    session: session({ id: `s-${id}`, ...over }),
  };
}

/** Instants in Manila, for readability: at('2026-09-16', '17:59'). */
export function at(day: string, hhmm: string): Date {
  return new Date(`${day}T${hhmm}:00.000+08:00`);
}
