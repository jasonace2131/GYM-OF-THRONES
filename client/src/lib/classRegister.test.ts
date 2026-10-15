import { describe, expect, it } from 'vitest';
import { MembershipStatus } from '@got/shared';
import type { MemberListItem } from './adminApi';
import {
  markResultFromWire,
  markedByLine,
  registerBadge,
  registerEntryFromWire,
  registerIsOpen,
  staffAddCheck,
  staffAddOutcome,
  stillWaiting,
  waitlistClosedNote,
  withRegisterCounts,
} from './classRegister';

/** A gym-local wall-clock time as an instant (Manila is UTC+8, no DST). */
const at = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00+08:00`);

const DAY = '2026-10-14';
const STARTS = at(DAY, '18:00').toISOString();
const ENDS = at(DAY, '19:00').toISOString();

describe('registerIsOpen', () => {
  it('opens 30 minutes before the start, not a minute earlier', () => {
    expect(registerIsOpen(STARTS, at(DAY, '17:29'))).toBe(false);
    expect(registerIsOpen(STARTS, at(DAY, '17:30'))).toBe(true);
    // Past days stay open: a register can be put right the next morning.
    expect(registerIsOpen(STARTS, at('2026-10-15', '09:00'))).toBe(true);
  });
});

/**
 * The deploy window: Vercel goes live before Render, so for a few minutes the
 * new console reads the old API, whose register rows and mark answers carry
 * none of the new fields. Read raw, the register crashed on
 * `markedBy.firstName` and badges read "#undefined".
 */
describe('reading an API of either age', () => {
  const member = { firstName: 'Maria', lastName: 'Santos', memberCode: 'ABC123' };

  it('gives an old register row the "nothing to say" values', () => {
    expect(registerEntryFromWire({ bookingId: 'b1', status: 'WAITLISTED', member })).toEqual({
      bookingId: 'b1',
      status: 'WAITLISTED',
      bookedAt: '',
      waitlistPosition: null,
      addedByStaff: false,
      markedAt: null,
      markedBy: null,
      member,
    });
  });

  it('passes a new row through untouched', () => {
    const row = {
      bookingId: 'b1',
      status: 'ATTENDED' as const,
      bookedAt: '2026-10-13T02:00:00.000Z',
      waitlistPosition: null,
      addedByStaff: true,
      markedAt: at(DAY, '18:05').toISOString(),
      markedBy: { firstName: 'Ana', lastName: 'Cruz' },
      member,
    };
    expect(registerEntryFromWire(row)).toEqual(row);
  });

  it('reads an old mark answer as a mark with no marker', () => {
    expect(markResultFromWire({ bookingId: 'b1', status: 'NO_SHOW' })).toEqual({
      bookingId: 'b1',
      status: 'NO_SHOW',
      markedAt: null,
      markedBy: null,
    });
    const answer = {
      bookingId: 'b1',
      status: 'ATTENDED' as const,
      markedAt: at(DAY, '18:05').toISOString(),
      markedBy: { firstName: 'Ana', lastName: 'Cruz' },
    };
    expect(markResultFromWire(answer)).toEqual(answer);
  });

  /** The backstop for a caller that reaches the helpers without a wrapper. */
  it('never prints "#undefined" or reads a missing marker', () => {
    const old = { status: 'WAITLISTED' } as Parameters<typeof registerBadge>[0];
    expect(registerBadge(old, STARTS, at(DAY, '12:00'))?.label).toBe('Waitlist');
    expect(markedByLine({} as Parameters<typeof markedByLine>[0], DAY)).toBeNull();
    expect(
      markedByLine(
        { markedAt: at(DAY, '18:42').toISOString() } as Parameters<typeof markedByLine>[0],
        DAY,
      ),
    ).toBe('Marked 6:42 PM');
  });
});

describe('registerBadge', () => {
  it('gives a waitlist row its queue place until the class starts', () => {
    const row = { status: 'WAITLISTED' as const, waitlistPosition: 2 };
    expect(registerBadge(row, STARTS, at(DAY, '12:00'))).toEqual({
      label: 'Waitlist · #2',
      tone: 'warn',
    });
    // After the waitlist closes but before the start, the place still stands.
    expect(registerBadge(row, STARTS, at(DAY, '17:00'))?.label).toBe('Waitlist · #2');
  });

  it('reads plain "Waitlist" when the server sent no place', () => {
    expect(
      registerBadge({ status: 'WAITLISTED', waitlistPosition: null }, STARTS, at(DAY, '12:00'))
        ?.label,
    ).toBe('Waitlist');
  });

  /** Not a no-show: they never had a seat to miss. */
  it('turns a waitlist row into a neutral "No place" once the class has started', () => {
    const row = { status: 'WAITLISTED' as const, waitlistPosition: 1 };
    expect(registerBadge(row, STARTS, at(DAY, '18:00'))).toEqual({
      label: 'No place',
      tone: 'neutral',
    });
    expect(registerBadge(row, STARTS, at('2026-10-20', '08:00'))?.label).toBe('No place');
  });

  it('badges marked rows and leaves an unmarked seat bare', () => {
    const now = at(DAY, '18:10');
    expect(registerBadge({ status: 'ATTENDED', waitlistPosition: null }, STARTS, now)).toEqual({
      label: 'Here',
      tone: 'ok',
    });
    expect(registerBadge({ status: 'NO_SHOW', waitlistPosition: null }, STARTS, now)).toEqual({
      label: 'No show',
      tone: 'neutral',
    });
    expect(registerBadge({ status: 'BOOKED', waitlistPosition: null }, STARTS, now)).toBeNull();
  });
});

describe('markedByLine', () => {
  const ana = { firstName: 'Ana', lastName: 'Cruz' };

  it('names the marker and the gym-local time', () => {
    expect(markedByLine({ markedAt: at(DAY, '18:42').toISOString(), markedBy: ana }, DAY)).toBe(
      'Marked by Ana Cruz · 6:42 PM',
    );
  });

  /** A correction the next morning must not read as if made during the class. */
  it('adds the day when the mark was made on another day', () => {
    expect(
      markedByLine({ markedAt: at('2026-10-15', '09:02').toISOString(), markedBy: ana }, DAY),
    ).toBe('Marked by Ana Cruz · Thu 15 Oct, 9:02 AM');
  });

  it('says nothing about an entry never marked, or marked before markers were kept', () => {
    expect(markedByLine({ markedAt: null, markedBy: null }, DAY)).toBeNull();
  });

  it('gives the time alone when no marker is on record', () => {
    expect(markedByLine({ markedAt: at(DAY, '18:42').toISOString(), markedBy: null }, DAY)).toBe(
      'Marked 6:42 PM',
    );
  });
});

describe('waitlistClosedNote', () => {
  it('speaks only between the cutoff and the start, and only with somebody waiting', () => {
    expect(waitlistClosedNote(STARTS, 2, at(DAY, '15:59'))).toBeNull();
    expect(waitlistClosedNote(STARTS, 2, at(DAY, '16:00'))).toBe(
      'The waitlist closed at 4:00 PM. Nobody moves up by themselves now: a free place goes to whoever books it first, or to somebody the desk adds.',
    );
    expect(waitlistClosedNote(STARTS, 0, at(DAY, '17:00'))).toBeNull();
    expect(waitlistClosedNote(STARTS, 2, at(DAY, '18:00'))).toBeNull();
  });
});

describe('stillWaiting', () => {
  const session = { startsAt: STARTS, cancelledAt: null, waitlistCount: 3 };

  it('counts the queue until the class starts — the cutoff included', () => {
    expect(stillWaiting(session, at(DAY, '12:00'))).toBe(3);
    // Closed, but a member waiting can still take a freed seat themselves.
    expect(stillWaiting(session, at(DAY, '17:59'))).toBe(3);
  });

  /** Their register rows read "No place" from the start on. */
  it('is zero once the class has started, or when the gym cancelled it', () => {
    expect(stillWaiting(session, at(DAY, '18:00'))).toBe(0);
    expect(stillWaiting(session, at('2026-10-20', '08:00'))).toBe(0);
    expect(
      stillWaiting({ ...session, cancelledAt: '2026-10-13T02:00:00.000Z' }, at(DAY, '12:00')),
    ).toBe(0);
  });
});

describe('withRegisterCounts', () => {
  const session = {
    startsAt: STARTS,
    endsAt: ENDS,
    cancelledAt: null,
    capacity: 3,
    bookedCount: 3,
    seatsLeft: 0,
    isFull: true,
    waitlistCount: 2,
  };
  const row = (status: 'BOOKED' | 'WAITLISTED' | 'ATTENDED' | 'NO_SHOW' | 'CANCELLED') => ({
    status,
  });

  /**
   * The timetable row still says full; the register just loaded shows the seat
   * a member gave up after the cutoff. The preview follows the register.
   */
  it('takes the seats from the rows, so a freed seat shows up after the cutoff', () => {
    const live = withRegisterCounts(session, [row('BOOKED'), row('BOOKED'), row('WAITLISTED')]);
    expect(live).toMatchObject({ bookedCount: 2, seatsLeft: 1, isFull: false, waitlistCount: 1 });
    expect(staffAddOutcome(session, at(DAY, '17:00'))).toBe('WAITLIST_CLOSED');
    expect(staffAddOutcome(live, at(DAY, '17:00'))).toBe('SEAT');
  });

  it('counts a marked row as a seat, and never a cancelled one', () => {
    expect(
      withRegisterCounts(session, [
        row('ATTENDED'),
        row('NO_SHOW'),
        row('BOOKED'),
        row('CANCELLED'),
        row('WAITLISTED'),
      ]),
    ).toMatchObject({ bookedCount: 3, seatsLeft: 0, isFull: true, waitlistCount: 1 });
  });

  it('keeps everything else about the class', () => {
    const live = withRegisterCounts(session, []);
    expect(live).toMatchObject({ startsAt: STARTS, capacity: 3, bookedCount: 0, seatsLeft: 3 });
  });
});

describe('staffAddOutcome', () => {
  const open = { startsAt: STARTS, endsAt: ENDS, seatsLeft: 3, cancelledAt: null };
  const full = { ...open, seatsLeft: 0 };

  it('books a free place, even into a class that is running', () => {
    expect(staffAddOutcome(open, at(DAY, '09:00'))).toBe('SEAT');
    expect(staffAddOutcome(open, at(DAY, '18:20'))).toBe('SEAT');
  });

  it('waitlists on a full class until the waitlist closes, then refuses', () => {
    expect(staffAddOutcome(full, at(DAY, '15:59'))).toBe('WAITLIST');
    expect(staffAddOutcome(full, at(DAY, '16:00'))).toBe('WAITLIST_CLOSED');
    expect(staffAddOutcome(full, at(DAY, '18:20'))).toBe('WAITLIST_CLOSED');
  });

  it('takes nobody once the class has ended, or when the gym cancelled it', () => {
    expect(staffAddOutcome(open, at(DAY, '19:00'))).toBe('FINISHED');
    expect(
      staffAddOutcome({ ...open, cancelledAt: '2026-10-13T02:00:00.000Z' }, at(DAY, '09:00')),
    ).toBe('CANCELLED');
  });
});

describe('staffAddCheck', () => {
  const TODAY = '2026-10-11';

  function member(over: Partial<MemberListItem> = {}): MemberListItem {
    return {
      userId: 'u1',
      memberCode: 'ABC123',
      firstName: 'Maria',
      lastName: 'Santos',
      email: 'maria@example.com',
      phone: null,
      avatarUrl: null,
      role: 'CLIENT',
      status: 'ACTIVE',
      joinedOn: '2026-01-05',
      lastSeenAt: null,
      deletedAt: null,
      emergencyContact: null,
      membership: {
        id: 'm1',
        planCode: 'MONTHLY',
        planName: 'Monthly',
        status: MembershipStatus.ACTIVE,
        startsOn: '2026-10-01',
        endsOn: '2026-10-31',
        daysRemaining: 20,
        cancelRequestedOn: null,
      },
      decision: 'ALLOW',
      allowReason: 'MEMBERSHIP_ACTIVE',
      denialReason: null,
      checkInCount: 4,
      ...over,
    };
  }

  const plan = (over: Partial<NonNullable<MemberListItem['membership']>>) =>
    member({ membership: { ...member().membership!, ...over } });

  it('says nothing when the plan covers the class day', () => {
    expect(staffAddCheck(member(), DAY, TODAY)).toBeNull();
    // The end date itself is covered.
    expect(staffAddCheck(plan({ endsOn: DAY }), DAY, TODAY)).toBeNull();
  });

  it('blocks a staff account — the server books members and nobody else', () => {
    expect(staffAddCheck(member({ role: 'COACH' }), DAY, TODAY)).toEqual({
      concern: 'NOT_A_MEMBER',
      blocks: true,
      message: 'Maria has a staff account. Only members can be booked into a class.',
    });
  });

  it('warns, without blocking, about an account the door will refuse', () => {
    const suspended = staffAddCheck(member({ status: 'SUSPENDED' }), DAY, TODAY);
    expect(suspended).toMatchObject({ concern: 'ACCOUNT', blocks: false });
    expect(staffAddCheck(member({ status: 'DEACTIVATED' }), DAY, TODAY)?.message).toBe(
      "Maria's account is deactivated, so the door will not let them in.",
    );
  });

  it('warns about a plan that ends before the class, or has ended', () => {
    expect(staffAddCheck(plan({ endsOn: '2026-10-13' }), DAY, TODAY)).toEqual({
      concern: 'PLAN',
      blocks: false,
      message: "Maria's plan ends 13 Oct 2026, before this class.",
    });
    expect(
      staffAddCheck(plan({ endsOn: '2026-10-02', status: MembershipStatus.EXPIRED }), DAY, TODAY)
        ?.message,
    ).toBe("Maria's plan ended 2 Oct 2026, so it does not cover this class.");
  });

  it('warns about no plan, a cancelled plan and a paused one', () => {
    expect(staffAddCheck(member({ membership: null }), DAY, TODAY)?.message).toBe(
      'Maria has no plan to cover this class.',
    );
    expect(staffAddCheck(plan({ status: MembershipStatus.CANCELLED }), DAY, TODAY)?.message).toBe(
      "Maria's plan was cancelled, so it does not cover this class.",
    );
    expect(staffAddCheck(plan({ status: MembershipStatus.FROZEN }), DAY, TODAY)?.message).toBe(
      "Maria's plan is paused right now. If it is still paused on Wed 14 Oct, it does not cover this class.",
    );
  });

  /** Grace days do not count (owner, 2026-10-11): the end date is the line. */
  it('does not stretch a plan into its grace days', () => {
    expect(staffAddCheck(plan({ endsOn: '2026-10-13' }), DAY, TODAY)?.concern).toBe('PLAN');
  });
});
