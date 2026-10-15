import { describe, expect, it } from 'vitest';
import { bookingNote } from './bookingNote';
import { at, booking } from './fixtures';

// Wed 16 Sep, 6:00 PM class: the waitlist closes at 4:00 PM.
const open = at('2026-09-16', '12:00');
const closed = at('2026-09-16', '16:30');
const started = at('2026-09-16', '18:05');
const full = { isFull: true, seatsLeft: 0, bookedCount: 16, waitlistCount: 3 };

describe('bookingNote — what happened, or what happens next', () => {
  it("a class the gym cancelled carries the gym's reason", () => {
    const row = booking('BOOKED', {
      cancelledAt: '2026-09-15T00:00:00.000Z',
      cancelReason: 'Coach is ill',
    });
    expect(bookingNote(row, open)).toEqual({
      text: 'The gym cancelled this: Coach is ill',
      tone: 'danger',
      link: null,
    });
  });

  /** Owner default, 2026-10-11: the member sees the reason the desk gave. */
  it('a removal by the gym carries the reason the desk gave', () => {
    const row = booking('CANCELLED', {}, 'b1', {
      cancelledBy: 'GYM',
      removalReason: 'Beginners only this week',
    });
    expect(bookingNote(row, open)).toEqual({
      text: 'The gym took you out of this class: Beginners only this week',
      tone: 'danger',
      link: null,
    });
  });

  it("the member's own cancellation needs no note", () => {
    expect(bookingNote(booking('CANCELLED'), open)).toBeNull();
  });

  it('before the cutoff: the place in the queue, and until when a seat comes by itself', () => {
    const row = booking('WAITLISTED', full, 'b1', { waitlistPosition: 2 });
    expect(bookingNote(row, open)?.text).toBe(
      "You're #2 in the queue. If a place opens up before 4:00 PM, you move in automatically.",
    );
  });

  /** The deploy window: an API one release behind sends no position field. */
  it('a row from an older API never reads "#undefined in the queue"', () => {
    const row = booking('WAITLISTED', full, 'b1', { waitlistPosition: undefined });
    expect(bookingNote(row, open)?.text).toBe(
      'If a place opens up before 4:00 PM, you move in automatically.',
    );
  });

  it('after the cutoff: nobody moves in by themselves any more', () => {
    const row = booking('WAITLISTED', full, 'b1', { waitlistPosition: null });
    expect(bookingNote(row, closed)).toEqual({
      text: 'The waitlist has closed. A place that frees up now goes to whoever books it first.',
      tone: 'muted',
      link: null,
    });
  });

  it('a free seat while still waiting points at the timetable to take it', () => {
    const row = booking('WAITLISTED', { seatsLeft: 1, isFull: false }, 'b1', {
      waitlistPosition: null,
    });
    expect(bookingNote(row, closed)).toEqual({
      text: 'A place is free. It goes to whoever books it first.',
      tone: 'muted',
      link: { label: 'Take it on the timetable', href: '/portal/schedule?day=2026-09-16' },
    });
  });

  it('once the class starts, the waitlist did not reach them', () => {
    expect(bookingNote(booking('WAITLISTED', full), started)?.text).toBe(
      "The waitlist didn't reach you.",
    );
  });

  it('a seat the waitlist gave them says so', () => {
    const row = booking('BOOKED', {}, 'b1', { promotedAt: '2026-09-15T08:00:00.000Z' });
    expect(bookingNote(row, open)).toEqual({
      text: 'A place opened up and you got it.',
      tone: 'ok',
      link: null,
    });
  });

  it('a seat the desk booked for them says so', () => {
    const row = booking('BOOKED', {}, 'b1', { addedByStaff: true });
    expect(bookingNote(row, open)?.text).toBe('The desk booked this place for you.');
  });

  it('an ordinary seat, or a class already marked, needs no note', () => {
    expect(bookingNote(booking('BOOKED'), open)).toBeNull();
    expect(bookingNote(booking('ATTENDED'), started)).toBeNull();
    expect(bookingNote(booking('NO_SHOW'), started)).toBeNull();
  });
});
