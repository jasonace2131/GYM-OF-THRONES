import { describe, expect, it } from 'vitest';
import { groupBookings } from './groupBookings';
import { at, booking } from './fixtures';

/** A one-hour class at `hhmm` Manila on `day`. */
const on = (day: string, hhmm: string) => ({
  businessDate: day,
  startsAt: at(day, hhmm).toISOString(),
  endsAt: new Date(at(day, hhmm).getTime() + 3_600_000).toISOString(),
});

const ids = (list: { bookingId: string }[]): string[] => list.map((item) => item.bookingId);

describe('groupBookings — On now, Coming up, Past', () => {
  // Half-way through the 6:00 PM class on Wed 16 Sep.
  const now = at('2026-09-16', '18:30');

  it('puts a class in exactly one group, by time', () => {
    const groups = groupBookings(
      [
        booking('BOOKED', on('2026-09-20', '09:00'), 'later'),
        booking('ATTENDED', on('2026-09-10', '07:00'), 'last-week'),
        booking('BOOKED', on('2026-09-16', '18:00'), 'now'),
        booking('ATTENDED', on('2026-09-15', '18:00'), 'yesterday'),
        booking('BOOKED', on('2026-09-17', '07:00'), 'next'),
      ],
      now,
    );
    expect(ids(groups.onNow)).toEqual(['now']);
    expect(ids(groups.comingUp)).toEqual(['next', 'later']);
    expect(ids(groups.past)).toEqual(['yesterday', 'last-week']);
  });

  /** F14: a class running now used to sit under "Been to". */
  it('a class is On now from its start, and Past only once it has ended', () => {
    const startsNow = booking('BOOKED', on('2026-09-16', '18:30'), 'starts-now');
    const endsNow = booking('BOOKED', on('2026-09-16', '17:30'), 'ends-now');
    const groups = groupBookings([startsNow, endsNow], now);
    expect(ids(groups.onNow)).toEqual(['starts-now']);
    expect(ids(groups.past)).toEqual(['ends-now']);
    expect(groups.comingUp).toEqual([]);
  });

  /** Placement is by time; the badge from bookingState says what became of each row. */
  it('keeps every status in its time group', () => {
    const groups = groupBookings(
      [
        booking('CANCELLED', on('2026-09-18', '07:00'), 'cancelled-ahead'),
        booking('NO_SHOW', on('2026-09-14', '07:00'), 'missed'),
        booking('WAITLISTED', on('2026-09-15', '07:00'), 'no-place'),
      ],
      now,
    );
    expect(ids(groups.comingUp)).toEqual(['cancelled-ahead']);
    expect(ids(groups.past)).toEqual(['no-place', 'missed']);
  });

  it('is empty for no bookings', () => {
    expect(groupBookings([], now)).toEqual({ onNow: [], comingUp: [], past: [] });
  });
});
