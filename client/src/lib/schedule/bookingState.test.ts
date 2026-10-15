import { describe, expect, it } from 'vitest';
import { bookingState, dayMarks, holdsPlace, waitingCount, waitlistClosed } from './bookingState';
import { at, booking, session } from './fixtures';

// The fixture class is Wed 16 Sep 2026, 6:00–7:00 PM Manila. Its waitlist
// closes 120 minutes before the start, at 4:00 PM.
const open = at('2026-09-16', '15:59');
const cutoff = at('2026-09-16', '16:00');
const before = at('2026-09-16', '17:59');
const after = at('2026-09-16', '18:00');

describe('bookingState — the one status vocabulary', () => {
  it('a class the gym cancelled wins over every status', () => {
    const view = bookingState(
      booking('BOOKED', { cancelledAt: '2026-09-15T00:00:00.000Z' }),
      before,
    );
    expect(view).toMatchObject({
      label: 'Class cancelled',
      tone: 'danger',
      canCancel: false,
      live: false,
    });

    const removed = booking('CANCELLED', { cancelledAt: '2026-09-15T00:00:00.000Z' }, 'b1', {
      cancelledBy: 'GYM',
      removalReason: 'Moved to beginners only',
    });
    expect(bookingState(removed, before).label).toBe('Class cancelled');
  });

  it('BOOKED before start is live and cancellable', () => {
    expect(bookingState(booking('BOOKED'), before)).toEqual({
      label: 'Booked',
      tone: 'ok',
      canCancel: true,
      dot: 'booked',
      live: true,
    });
  });

  it('BOOKED once started reads Not marked, never Booked', () => {
    expect(bookingState(booking('BOOKED'), after)).toMatchObject({
      label: 'Not marked',
      tone: 'neutral',
      canCancel: false,
      live: false,
    });
  });

  it('ATTENDED, NO_SHOW and CANCELLED are never cancellable', () => {
    expect(bookingState(booking('ATTENDED'), before)).toMatchObject({
      label: 'Attended',
      tone: 'info',
      canCancel: false,
      dot: 'attended',
    });
    expect(bookingState(booking('NO_SHOW'), after)).toMatchObject({
      label: 'Missed',
      tone: 'danger',
      canCancel: false,
    });
    expect(bookingState(booking('CANCELLED'), before)).toMatchObject({
      label: 'You cancelled',
      tone: 'neutral',
      canCancel: false,
    });
  });

  /** F9: the desk taking a member out is not the member's own doing. */
  it('a booking the gym removed reads Removed by the gym, never You cancelled', () => {
    const removed = booking('CANCELLED', {}, 'b1', {
      cancelledBy: 'GYM',
      removalReason: 'Moved to beginners only',
    });
    expect(bookingState(removed, before)).toEqual({
      label: 'Removed by the gym',
      tone: 'danger',
      canCancel: false,
      dot: 'other',
      live: false,
    });
  });
});

describe('bookingState — a waitlist place, in its three phases', () => {
  it('before the cutoff: its place in the queue, live and cancellable', () => {
    expect(bookingState(booking('WAITLISTED', {}, 'b1', { waitlistPosition: 3 }), open)).toEqual({
      label: 'Waitlist · #3',
      tone: 'warn',
      canCancel: true,
      dot: 'waitlist',
      live: true,
    });
  });

  it('a row without a position still says what it is, without inventing a number', () => {
    const view = bookingState(booking('WAITLISTED', {}, 'b1', { waitlistPosition: null }), open);
    expect(view.label).toBe('Waitlist');
  });

  /** The deploy window: an API one release behind sends no field at all. */
  it('a row from an older API, with no position field, never reads "#undefined"', () => {
    const view = bookingState(
      booking('WAITLISTED', {}, 'b1', { waitlistPosition: undefined }),
      open,
    );
    expect(view.label).toBe('Waitlist');
  });

  it('from the cutoff to the start: closed and neutral, and the member may still leave', () => {
    const closed = {
      label: 'Waitlist closed',
      tone: 'neutral',
      canCancel: true,
      dot: 'waitlist',
      live: true,
    };
    // The server sends no position once the waitlist has closed.
    const waiting = booking('WAITLISTED', {}, 'b1', { waitlistPosition: null });
    expect(bookingState(waiting, cutoff)).toEqual(closed);
    expect(bookingState(waiting, before)).toEqual(closed);
  });

  /** F7: it used to read "Waitlist" forever, with the warn-coloured dot. */
  it('from the start: No place — neutral, not live, and filed under the "other" dot', () => {
    expect(bookingState(booking('WAITLISTED'), after)).toEqual({
      label: 'No place',
      tone: 'neutral',
      canCancel: false,
      dot: 'other',
      live: false,
    });
  });
});

describe('waitlistClosed', () => {
  it('closes exactly 120 minutes before the start', () => {
    const startsAt = at('2026-09-16', '18:00').toISOString();
    expect(waitlistClosed(startsAt, open)).toBe(false);
    expect(waitlistClosed(startsAt, cutoff)).toBe(true);
  });
});

describe('waitingCount', () => {
  const queued = session({ isFull: true, seatsLeft: 0, bookedCount: 16, waitlistCount: 3 });

  it('is the length of the queue until the class starts, the closed waitlist included', () => {
    expect(waitingCount(queued, open)).toBe(3);
    expect(waitingCount(queued, before)).toBe(3);
  });

  /** It used to read "· 3 waiting" beside rows that already said "No place". */
  it('is null once the class has started, and on a class the gym called off', () => {
    expect(waitingCount(queued, after)).toBeNull();
    expect(waitingCount({ ...queued, cancelledAt: '2026-09-15T00:00:00.000Z' }, open)).toBeNull();
  });

  it('is null when nobody is waiting', () => {
    expect(waitingCount(session(), open)).toBeNull();
  });
});

describe('holdsPlace', () => {
  it('is true for every status except CANCELLED', () => {
    expect(holdsPlace(booking('BOOKED'))).toBe(true);
    expect(holdsPlace(booking('WAITLISTED'))).toBe(true);
    expect(holdsPlace(booking('ATTENDED'))).toBe(true);
    expect(holdsPlace(booking('NO_SHOW'))).toBe(true);
    expect(holdsPlace(booking('CANCELLED'))).toBe(false);
  });
});

describe('dayMarks', () => {
  const morning = {
    startsAt: at('2026-09-16', '06:00').toISOString(),
    endsAt: at('2026-09-16', '07:00').toISOString(),
  };

  it('keeps the most relevant dot per day: booked > waitlist > attended > other', () => {
    const marks = dayMarks(
      [
        booking('ATTENDED', {}, 'a'),
        booking('BOOKED', {}, 'b'),
        booking(
          'CANCELLED',
          { businessDate: '2026-09-17', startsAt: '2026-09-17T10:00:00.000Z' },
          'c',
        ),
      ],
      before,
    );
    expect(marks.get('2026-09-16')).toBe('booked');
    expect(marks.get('2026-09-17')).toBe('other');
  });

  it('a waitlist place still waiting outranks a class attended that morning', () => {
    const marks = dayMarks(
      [booking('ATTENDED', morning, 'a'), booking('WAITLISTED', {}, 'w')],
      open,
    );
    expect(marks.get('2026-09-16')).toBe('waitlist');
  });

  /** F7: a place the waitlist never reached must not hide the class they went to. */
  it('a waitlist place the class started without never outranks an attended class', () => {
    const marks = dayMarks(
      [booking('ATTENDED', morning, 'a'), booking('WAITLISTED', {}, 'w')],
      after,
    );
    expect(marks.get('2026-09-16')).toBe('attended');
  });
});
