import { describe, expect, it } from 'vitest';
import { summariseUpcoming } from './upcoming';
import { at, booking } from './fixtures';

describe('summariseUpcoming', () => {
  const now = at('2026-09-09', '20:45');
  const on = (day: string, hhmm: string) => ({
    businessDate: day,
    startsAt: at(day, hhmm).toISOString(),
    endsAt: new Date(at(day, hhmm).getTime() + 3_600_000).toISOString(),
  });

  it('orders live bookings soonest first, and Next up skips a waitlist place', () => {
    const result = summariseUpcoming(
      [
        booking('BOOKED', on('2026-09-16', '18:00'), 'yoga'),
        booking('WAITLISTED', on('2026-09-10', '06:00'), 'hiit'),
        booking('BOOKED', on('2026-09-10', '07:00'), 'intro'),
      ],
      now,
    );
    expect(result.upcoming.map((b) => b.bookingId)).toEqual(['hiit', 'intro', 'yoga']);
    expect(result.next?.bookingId).toBe('intro');
  });

  /** The "Booked" tile counts seats. A waitlist place is not a booking yet. */
  it('counts seats and waitlist places apart', () => {
    const result = summariseUpcoming(
      [
        booking('BOOKED', on('2026-09-16', '18:00'), 'yoga'),
        booking('WAITLISTED', on('2026-09-10', '06:00'), 'hiit'),
        booking('BOOKED', on('2026-09-10', '07:00'), 'intro'),
      ],
      now,
    );
    expect(result.booked).toBe(2);
    expect(result.waitlisted).toBe(1);
  });

  it('a waitlist place whose waitlist has closed is still listed, and still not a seat', () => {
    // 10:00 PM tonight: its waitlist closed at 8:00 PM, before `now`.
    const result = summariseUpcoming(
      [booking('WAITLISTED', on('2026-09-09', '22:00'), 'late')],
      now,
    );
    expect(result.upcoming.map((b) => b.bookingId)).toEqual(['late']);
    expect(result).toMatchObject({ next: null, booked: 0, waitlisted: 1 });
  });

  it('leaves out started, cancelled, attended and gym-cancelled classes', () => {
    const result = summariseUpcoming(
      [
        booking('BOOKED', on('2026-09-09', '19:00'), 'started'),
        booking('CANCELLED', on('2026-09-12', '09:00'), 'mine-cancelled'),
        booking('ATTENDED', on('2026-09-09', '06:00'), 'attended'),
        booking(
          'BOOKED',
          { ...on('2026-09-12', '10:30'), cancelledAt: '2026-09-11T00:00:00.000Z' },
          'gym-cancelled',
        ),
        booking('WAITLISTED', on('2026-09-09', '19:30'), 'no-place'),
      ],
      now,
    );
    expect(result).toEqual({ next: null, upcoming: [], booked: 0, waitlisted: 0 });
  });

  it('caps the list but not the count', () => {
    const many = ['11', '12', '13', '14'].map((d, i) =>
      booking('BOOKED', on(`2026-09-${d}`, '07:00'), `b${i}`),
    );
    const result = summariseUpcoming(many, now);
    expect(result.upcoming).toHaveLength(3);
    expect(result.booked).toBe(4);
  });
});
