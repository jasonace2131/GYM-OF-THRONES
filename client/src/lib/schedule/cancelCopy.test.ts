import { describe, expect, it } from 'vitest';
import {
  cancelConsequence,
  cancelUntil,
  registerOpensLabel,
  relativeDay,
  waitlistClosesLabel,
  waitlistClosesTime,
  waitlistJoinedCopy,
} from './cancelCopy';
import { at, booking } from './fixtures';

describe('relativeDay', () => {
  it('says today, tomorrow, or the short date', () => {
    expect(relativeDay('2026-09-09', '2026-09-09')).toBe('today');
    expect(relativeDay('2026-09-10', '2026-09-09')).toBe('tomorrow');
    expect(relativeDay('2026-09-16', '2026-09-09')).toBe('Wed 16 Sep');
  });
});

describe('cancelUntil', () => {
  const now = at('2026-09-09', '20:45');
  it('names the start time and the day', () => {
    expect(cancelUntil(at('2026-09-10', '07:00').toISOString(), now)).toBe(
      'Cancel until 7:00 AM tomorrow',
    );
    expect(cancelUntil(at('2026-09-09', '21:30').toISOString(), now)).toBe(
      'Cancel until 9:30 PM today',
    );
    expect(cancelUntil(at('2026-09-16', '18:00').toISOString(), now)).toBe(
      'Cancel until 6:00 PM Wed 16 Sep',
    );
  });

  it('a waitlist place is left, not cancelled', () => {
    expect(cancelUntil(at('2026-09-10', '07:00').toISOString(), now, 'Leave')).toBe(
      'Leave until 7:00 AM tomorrow',
    );
  });
});

describe('registerOpensLabel', () => {
  it('is 30 minutes before start, with the day only when it is not today', () => {
    expect(
      registerOpensLabel(at('2026-09-16', '18:00').toISOString(), at('2026-09-16', '12:00')),
    ).toBe('Register opens 5:30 PM');
    expect(
      registerOpensLabel(at('2026-09-10', '07:00').toISOString(), at('2026-09-09', '20:45')),
    ).toBe('Register opens 6:30 AM tomorrow');
  });
});

describe('waitlistClosesLabel', () => {
  it('is 120 minutes before start, with the day only when it is not today', () => {
    expect(
      waitlistClosesLabel(at('2026-09-16', '18:00').toISOString(), at('2026-09-16', '12:00')),
    ).toBe('Waitlist closes 4:00 PM');
    expect(
      waitlistClosesLabel(at('2026-09-10', '07:00').toISOString(), at('2026-09-09', '20:45')),
    ).toBe('Waitlist closes 5:00 AM tomorrow');
    expect(
      waitlistClosesLabel(at('2026-09-16', '18:00').toISOString(), at('2026-09-09', '20:45')),
    ).toBe('Waitlist closes 4:00 PM Wed 16 Sep');
  });

  /** The day is the closing instant's, not the class's: a 1 AM class closes the evening before. */
  it('takes the day from when it closes, not from the class', () => {
    expect(
      waitlistClosesTime(at('2026-09-17', '01:00').toISOString(), at('2026-09-16', '12:00')),
    ).toBe('11:00 PM');
  });
});

describe('cancelConsequence — what happens to the place given up', () => {
  // Wed 16 Sep, 6:00 PM class: the waitlist closes at 4:00 PM.
  const open = at('2026-09-16', '15:59');
  const closed = at('2026-09-16', '16:00');
  const full = { isFull: true, seatsLeft: 0, bookedCount: 16 };

  it('a seat, before the cutoff, goes to the next person waiting — when somebody is', () => {
    expect(cancelConsequence(booking('BOOKED', { ...full, waitlistCount: 2 }), open)).toBe(
      'Your place goes to the next person on the waitlist.',
    );
    expect(cancelConsequence(booking('BOOKED', { waitlistCount: 0 }), open)).toBe(
      'Your place opens up for someone else to book.',
    );
  });

  /** Owner, 2026-10-11: after the cutoff a freed seat is first come, first served. */
  it('a seat, after the cutoff, goes to whoever books it first — never the queue', () => {
    expect(cancelConsequence(booking('BOOKED', { ...full, waitlistCount: 3 }), closed)).toBe(
      'The waitlist has closed, so your place goes to whoever books it first.',
    );
  });

  it('a waitlist place names the queue place being given up', () => {
    expect(
      cancelConsequence(booking('WAITLISTED', full, 'b1', { waitlistPosition: 2 }), open),
    ).toBe("You lose your place in the queue. You're #2.");
    expect(
      cancelConsequence(booking('WAITLISTED', full, 'b1', { waitlistPosition: null }), open),
    ).toBe('You lose your place in the queue.');
  });

  /** The deploy window: an API one release behind sends no position, and no count. */
  it('a row from an older API never names "#undefined" or counts NaN', () => {
    expect(
      cancelConsequence(booking('WAITLISTED', full, 'b1', { waitlistPosition: undefined }), open),
    ).toBe('You lose your place in the queue.');
    expect(cancelConsequence(booking('BOOKED', { waitlistCount: undefined }), open)).toBe(
      'Your place opens up for someone else to book.',
    );
  });

  it('a waitlist place after the cutoff has no queue left to lose', () => {
    expect(
      cancelConsequence(booking('WAITLISTED', full, 'b1', { waitlistPosition: null }), closed),
    ).toBe('You come off the waitlist for this class.');
  });
});

describe('waitlistJoinedCopy', () => {
  it('names the place in the queue and when the waitlist closes', () => {
    const joined = booking('WAITLISTED', {}, 'b1', { waitlistPosition: 3 });
    expect(waitlistJoinedCopy(joined, at('2026-09-16', '12:00'))).toEqual({
      title: "You're #3 on the waitlist for Yoga",
      description: 'If a place opens up before 4:00 PM, you move in automatically.',
    });
  });

  it('a reply from an older API, with no position field, never reads "#undefined"', () => {
    const joined = booking('WAITLISTED', {}, 'b1', { waitlistPosition: undefined });
    expect(waitlistJoinedCopy(joined, at('2026-09-16', '12:00')).title).toBe(
      'On the waitlist for Yoga',
    );
  });

  it('without a position it still confirms the waitlist', () => {
    const joined = booking('WAITLISTED', {}, 'b1', { waitlistPosition: null });
    expect(waitlistJoinedCopy(joined, at('2026-09-15', '09:00')).title).toBe(
      'On the waitlist for Yoga',
    );
    expect(waitlistJoinedCopy(joined, at('2026-09-15', '09:00')).description).toBe(
      'If a place opens up before 4:00 PM tomorrow, you move in automatically.',
    );
  });
});
