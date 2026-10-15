import {
  CLASS_BOOKING_WINDOW_DAYS,
  CLASS_PRIORITY_BOOKING_WINDOW_DAYS,
  CLASS_WAITLIST_CLOSES_MINUTES_BEFORE,
  DENIAL_MEMBER_COPY,
  DenialReason,
  PRIORITY_BOOKING_PLAN_CODES,
  bookingRefusalCopy,
  bookingWindowDaysFor,
  waitlistClosesAt,
} from '@got/shared';
import {
  bookingAddedByStaff,
  bookingCancelledBy,
  toClassRegisterEntry,
  toClassSession,
  toMarkAttendanceResult,
  toMyBooking,
  type ClassSessionRow,
  type MarkedRow,
  type MyBookingRow,
  type RegisterRow,
} from './class.presenter';

const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const DESK_ID = '66666666-6666-4666-8666-666666666666';

const session = (over: Partial<ClassSessionRow> = {}): ClassSessionRow => ({
  id: 'c1',
  title: 'HIIT Conditioning',
  description: null,
  coachId: '11111111-1111-4111-8111-111111111111',
  // 22:00 UTC is 06:00 the NEXT day in Manila — the case that catches a
  // presenter deriving the gym day from the instant's UTC date.
  startsAt: new Date('2026-08-25T22:00:00.000Z'),
  endsAt: new Date('2026-08-25T23:00:00.000Z'),
  businessDate: new Date('2026-08-26T00:00:00.000Z'),
  capacity: 16,
  bookedCount: 9,
  cancelledAt: null,
  cancelReason: null,
  coach: { firstName: 'Ana', lastName: 'Cruz' },
  _count: { bookings: 0 },
  ...over,
});

/** A member's own booking, booked straight in, with nobody else recorded on it. */
const bookingRow = (over: Partial<MyBookingRow> = {}): MyBookingRow => ({
  id: 'b1',
  userId: MEMBER_ID,
  status: 'BOOKED',
  bookedAt: new Date('2026-08-20T01:00:00.000Z'),
  promotedAt: null,
  attendedAt: null,
  cancelledAt: null,
  bookedById: null,
  cancelledById: null,
  removalReason: null,
  session: session(),
  ...over,
});

describe('toClassSession', () => {
  it('derives seats and fullness once, so no two screens can disagree', () => {
    const dto = toClassSession(session());
    expect(dto.seatsLeft).toBe(7);
    expect(dto.isFull).toBe(false);
  });

  it('reports a full class as full', () => {
    const dto = toClassSession(session({ bookedCount: 16 }));
    expect(dto.seatsLeft).toBe(0);
    expect(dto.isFull).toBe(true);
  });

  /**
   * `bookedCount` can never exceed `capacity` — a CHECK constraint guarantees
   * it — but `seatsLeft` clamps anyway. A negative "seats left" on a screen is
   * worse than a wrong one, because it tells the member the product is broken.
   */
  it('never reports negative seats', () => {
    expect(toClassSession(session({ bookedCount: 20 })).seatsLeft).toBe(0);
  });

  it('reads the business date at UTC, so a 6am Manila class is not yesterday', () => {
    expect(toClassSession(session()).businessDate).toBe('2026-08-26');
  });

  it('sends instants as ISO, never as display text', () => {
    const dto = toClassSession(session());
    expect(dto.startsAt).toBe('2026-08-25T22:00:00.000Z');
    expect(dto.startsAt).not.toContain('Aug');
  });

  it('surfaces a cancellation with its reason rather than hiding the class', () => {
    const dto = toClassSession(
      session({ cancelledAt: new Date('2026-08-24T02:00:00.000Z'), cancelReason: 'Coach unwell' }),
    );
    expect(dto.cancelledAt).toBe('2026-08-24T02:00:00.000Z');
    expect(dto.cancelReason).toBe('Coach unwell');
  });

  it('joins the coach name from its parts', () => {
    expect(toClassSession(session()).coachName).toBe('Ana Cruz');
  });

  // `_count` is required on the row, so every path that answers with a session
  // has loaded it — there is no "not counted, reads 0" any more.
  it('reads the waitlist length from the filtered relation count', () => {
    expect(
      toClassSession(session({ bookedCount: 16, _count: { bookings: 3 } })).waitlistCount,
    ).toBe(3);
    expect(toClassSession(session()).waitlistCount).toBe(0);
  });
});

describe('toMyBooking', () => {
  it('carries the promotion timestamp, so a member can be told they got in', () => {
    const dto = toMyBooking(
      bookingRow({ promotedAt: new Date('2026-08-24T09:00:00.000Z') }),
      'Asia/Manila',
    );

    expect(dto.status).toBe('BOOKED');
    expect(dto.promotedAt).toBe('2026-08-24T09:00:00.000Z');
    expect(dto.session.title).toBe('HIIT Conditioning');
  });

  it('leaves promotedAt null for somebody who booked straight in', () => {
    const dto = toMyBooking(bookingRow({ id: 'b2' }), 'Asia/Manila');
    expect(dto.promotedAt).toBeNull();
  });

  it('carries the session waitlist count through to the member', () => {
    const dto = toMyBooking(
      bookingRow({ session: session({ bookedCount: 16, _count: { bookings: 2 } }) }),
      'Asia/Manila',
    );
    expect(dto.session.waitlistCount).toBe(2);
  });
});

describe('toMyBooking — register and cancellation instants', () => {
  it('sends attendedAt and cancelledAt as ISO or null', () => {
    const row = bookingRow({
      status: 'ATTENDED',
      bookedAt: new Date('2026-09-01T02:00:00.000Z'),
      attendedAt: new Date('2026-09-16T10:02:00.000Z'),
    });

    const dto = toMyBooking(row, 'Asia/Manila');

    expect(dto.attendedAt).toBe('2026-09-16T10:02:00.000Z');
    expect(dto.cancelledAt).toBeNull();
    expect(dto.status).toBe('ATTENDED');
  });
});

describe('toMyBooking — the waitlist position', () => {
  it("passes the caller's queue place through for a WAITLISTED booking", () => {
    const dto = toMyBooking(bookingRow({ status: 'WAITLISTED' }), 'Asia/Manila', 2);
    expect(dto.waitlistPosition).toBe(2);
  });

  // After the cutoff the caller passes null: a place number would promise a seat.
  it('leaves a WAITLISTED booking without a place when the caller has none', () => {
    expect(
      toMyBooking(bookingRow({ status: 'WAITLISTED' }), 'Asia/Manila').waitlistPosition,
    ).toBeNull();
  });

  it('drops a position on a booking that is not on the waitlist', () => {
    for (const status of ['BOOKED', 'ATTENDED', 'NO_SHOW', 'CANCELLED']) {
      expect(toMyBooking(bookingRow({ status }), 'Asia/Manila', 1).waitlistPosition).toBeNull();
    }
  });
});

describe('toMyBooking — who cancelled, and who booked', () => {
  const cancelled = (over: Partial<MyBookingRow> = {}): MyBookingRow =>
    bookingRow({ status: 'CANCELLED', cancelledAt: new Date('2026-08-21T03:00:00.000Z'), ...over });

  it('says nothing about a canceller while the booking is live', () => {
    const dto = toMyBooking(bookingRow(), 'Asia/Manila');
    expect(dto.cancelledBy).toBeNull();
    expect(dto.removalReason).toBeNull();
  });

  it("reads the member's own cancellation as theirs", () => {
    const dto = toMyBooking(cancelled({ cancelledById: MEMBER_ID }), 'Asia/Manila');
    expect(dto.cancelledBy).toBe('MEMBER');
    expect(dto.removalReason).toBeNull();
  });

  // Before the canceller was recorded, the member was the only one who could cancel.
  it("reads a cancellation with no canceller recorded as the member's", () => {
    expect(toMyBooking(cancelled(), 'Asia/Manila').cancelledBy).toBe('MEMBER');
  });

  it("reads a removal by the desk as the gym's, with the reason the member is shown", () => {
    const dto = toMyBooking(
      cancelled({ cancelledById: DESK_ID, removalReason: 'Class moved to the small studio' }),
      'Asia/Manila',
    );
    expect(dto.cancelledBy).toBe('GYM');
    expect(dto.removalReason).toBe('Class moved to the small studio');
  });

  it("never shows a reason on the member's own cancellation", () => {
    const dto = toMyBooking(
      cancelled({ cancelledById: MEMBER_ID, removalReason: 'stray' }),
      'Asia/Manila',
    );
    expect(dto.removalReason).toBeNull();
  });

  it('marks a place the desk booked by hand, and only that', () => {
    expect(toMyBooking(bookingRow({ bookedById: DESK_ID }), 'Asia/Manila').addedByStaff).toBe(true);
    expect(toMyBooking(bookingRow(), 'Asia/Manila').addedByStaff).toBe(false);
  });
});

describe('toClassRegisterEntry — one register row', () => {
  const registerRow = (over: Partial<RegisterRow> = {}): RegisterRow => ({
    id: 'b1',
    userId: MEMBER_ID,
    status: 'BOOKED',
    bookedAt: new Date('2026-08-20T01:00:00.000Z'),
    bookedById: null,
    markedAt: null,
    user: { firstName: 'Juan', lastName: 'Dela Cruz', memberCode: 'GOT-0007' },
    markedBy: null,
    ...over,
  });

  it('carries the member, the booking instant as ISO, and no marker on an unmarked seat', () => {
    expect(toClassRegisterEntry(registerRow())).toEqual({
      bookingId: 'b1',
      status: 'BOOKED',
      bookedAt: '2026-08-20T01:00:00.000Z',
      waitlistPosition: null,
      addedByStaff: false,
      markedAt: null,
      markedBy: null,
      member: { firstName: 'Juan', lastName: 'Dela Cruz', memberCode: 'GOT-0007' },
    });
  });

  it('says who marked the entry, and when', () => {
    const entry = toClassRegisterEntry(
      registerRow({
        status: 'NO_SHOW',
        markedAt: new Date('2026-08-26T22:40:00.000Z'),
        markedBy: { firstName: 'Ana', lastName: 'Cruz' },
      }),
    );
    expect(entry.markedAt).toBe('2026-08-26T22:40:00.000Z');
    expect(entry.markedBy).toEqual({ firstName: 'Ana', lastName: 'Cruz' });
  });

  it('numbers a waitlist row with the place the caller gives, and only a waitlist row', () => {
    expect(toClassRegisterEntry(registerRow({ status: 'WAITLISTED' }), 3).waitlistPosition).toBe(3);
    expect(toClassRegisterEntry(registerRow(), 3).waitlistPosition).toBeNull();
  });

  it('flags a place the desk added by hand', () => {
    expect(toClassRegisterEntry(registerRow({ bookedById: DESK_ID })).addedByStaff).toBe(true);
  });

  // A relation select that later grows (an email, a phone) must not reach
  // every coach's screen by a spread.
  it('copies the member and the marker field by field, never by spreading', () => {
    const user = Object.assign(
      { firstName: 'Juan', lastName: 'Dela Cruz', memberCode: null },
      { email: 'juan@example.com' },
    );
    const markedBy = Object.assign({ firstName: 'Ana', lastName: 'Cruz' }, { phone: '0917' });
    const entry = toClassRegisterEntry(
      registerRow({ status: 'ATTENDED', markedAt: new Date(), user, markedBy }),
    );
    expect(Object.keys(entry.member).sort()).toEqual(['firstName', 'lastName', 'memberCode']);
    expect(Object.keys(entry.markedBy ?? {}).sort()).toEqual(['firstName', 'lastName']);
  });
});

describe('toMarkAttendanceResult — what marking one entry answers', () => {
  const marked = (over: Partial<MarkedRow> = {}): MarkedRow => ({
    id: 'b1',
    status: 'ATTENDED',
    markedAt: new Date('2026-08-26T22:05:00.000Z'),
    markedBy: { firstName: 'Ana', lastName: 'Cruz' },
    ...over,
  });

  it('carries the outcome, the marker and the time, for both outcomes', () => {
    expect(toMarkAttendanceResult(marked())).toEqual({
      bookingId: 'b1',
      status: 'ATTENDED',
      markedAt: '2026-08-26T22:05:00.000Z',
      markedBy: { firstName: 'Ana', lastName: 'Cruz' },
    });
    expect(toMarkAttendanceResult(marked({ status: 'NO_SHOW' })).status).toBe('NO_SHOW');
  });

  // The UPDATE that returned the row wrote both: a missing one is a bug to
  // fail on, not a "Marked by null" to send.
  it('refuses a row with no marker, or one that is not marked', () => {
    expect(() => toMarkAttendanceResult(marked({ markedBy: null }))).toThrow(/without a marker/);
    expect(() => toMarkAttendanceResult(marked({ markedAt: null }))).toThrow(/without a marker/);
    expect(() => toMarkAttendanceResult(marked({ status: 'BOOKED' }))).toThrow(/as BOOKED/);
  });
});

describe('the derivation helpers the register shares', () => {
  it('bookingCancelledBy is null unless the booking is CANCELLED', () => {
    expect(
      bookingCancelledBy({ status: 'WAITLISTED', userId: MEMBER_ID, cancelledById: null }),
    ).toBeNull();
    expect(
      bookingCancelledBy({ status: 'CANCELLED', userId: MEMBER_ID, cancelledById: DESK_ID }),
    ).toBe('GYM');
  });

  it('bookingAddedByStaff does not count the member booking themselves', () => {
    expect(bookingAddedByStaff({ userId: MEMBER_ID, bookedById: MEMBER_ID })).toBe(false);
    expect(bookingAddedByStaff({ userId: MEMBER_ID, bookedById: DESK_ID })).toBe(true);
  });
});

/**
 * The class rules both runtimes read from @got/shared (owner, 2026-10-11).
 * Pinned here, beside the classes wire contract, because the shared package has
 * no test runner of its own — changing one of these numbers or the plan list
 * should be a deliberate edit to this file too.
 */
describe('the shared class rules — waitlist cutoff and booking window', () => {
  it('closes the waitlist two hours before the class starts', () => {
    expect(CLASS_WAITLIST_CLOSES_MINUTES_BEFORE).toBe(120);
    // 6:00 PM Manila → 4:00 PM Manila, from either an ISO string or a Date.
    expect(waitlistClosesAt('2026-09-16T10:00:00.000Z').toISOString()).toBe(
      '2026-09-16T08:00:00.000Z',
    );
    expect(waitlistClosesAt(new Date('2026-09-16T10:00:00.000Z')).toISOString()).toBe(
      '2026-09-16T08:00:00.000Z',
    );
  });

  it('gives two weeks to everyone and three to the priority plans, today included', () => {
    expect(CLASS_BOOKING_WINDOW_DAYS).toBe(14);
    expect(CLASS_PRIORITY_BOOKING_WINDOW_DAYS).toBe(21);
    expect(PRIORITY_BOOKING_PLAN_CODES).toEqual(['QUARTERLY', 'ANNUAL']);
    expect(bookingWindowDaysFor('QUARTERLY')).toBe(21);
    expect(bookingWindowDaysFor('ANNUAL')).toBe(21);
    expect(bookingWindowDaysFor('MONTHLY')).toBe(14);
  });

  // No plan, or a code the server did not load, is the standard window — the
  // plan check itself is a separate refusal.
  it('falls back to the standard window without a plan code', () => {
    expect(bookingWindowDaysFor(null)).toBe(14);
    expect(bookingWindowDaysFor(undefined)).toBe(14);
    // Plan.code is an exact machine code; a near miss is not priority.
    expect(bookingWindowDaysFor('quarterly')).toBe(14);
  });
});

/**
 * `bookingRefusalCopy` (@got/shared) is the sentence a refused booking and the
 * timetable's banner both show.
 */
describe('bookingRefusalCopy — the member copy for a booking their plan does not cover', () => {
  const MEMBERSHIP_REASONS = [
    DenialReason.NO_MEMBERSHIP,
    DenialReason.MEMBERSHIP_EXPIRED,
    DenialReason.MEMBERSHIP_CANCELLED,
    DenialReason.MEMBERSHIP_FROZEN,
  ];

  it('sends a member with no plan to the Subscription page or the desk', () => {
    expect(bookingRefusalCopy(DenialReason.NO_MEMBERSHIP, null)).toBe(
      'You need a plan to book classes. Choose one on your Subscription page or at the desk.',
    );
  });

  it('names the last covered day when the plan ends before the class', () => {
    expect(bookingRefusalCopy(DenialReason.MEMBERSHIP_EXPIRED, '16 Aug')).toBe(
      'Your plan ends 16 Aug, before this class. Renew to book it.',
    );
    expect(bookingRefusalCopy(DenialReason.MEMBERSHIP_CANCELLED, '16 Aug')).toBe(
      'Your plan ends 16 Aug, before this class. Start a new plan to book it.',
    );
  });

  it('says the plan has ended when there is no date to give', () => {
    expect(bookingRefusalCopy(DenialReason.MEMBERSHIP_EXPIRED, null)).toBe(
      'Your plan has ended. Renew to book classes.',
    );
    expect(bookingRefusalCopy(DenialReason.MEMBERSHIP_CANCELLED, null)).toBe(
      'Your plan has ended. Start a new plan to book classes.',
    );
  });

  it('names the day a pause ends, when it has one', () => {
    expect(bookingRefusalCopy(DenialReason.MEMBERSHIP_FROZEN, '2 Nov')).toBe(
      "Classes can't be booked during your plan's pause, which ends 2 Nov.",
    );
    expect(bookingRefusalCopy(DenialReason.MEMBERSHIP_FROZEN, null)).toBe(
      "Your plan is paused, so classes can't be booked.",
    );
  });

  // §9.5: why an account has a note is between the member and management.
  it.each([DenialReason.ACCOUNT_SUSPENDED, DenialReason.ACCOUNT_DEACTIVATED])(
    'keeps %s vague and never puts a date on it',
    (reason) => {
      expect(bookingRefusalCopy(reason, '16 Aug')).toBe(
        "There's a note on your account. Please talk to the desk.",
      );
    },
  );

  // The door's copy is about today, at the counter. A class is a later day.
  it('never borrows the door copy, and never quotes a price', () => {
    for (const reason of MEMBERSHIP_REASONS) {
      for (const date of ['16 Aug', null]) {
        const copy = bookingRefusalCopy(reason, date);
        expect(copy).not.toContain('sell you today');
        expect(copy).not.toBe(DENIAL_MEMBER_COPY[reason]);
        expect(copy).not.toMatch(/₱|PHP|\d+\.\d{2}/);
      }
    }
  });

  it('falls back to the door copy for a reason that never refuses a booking', () => {
    expect(bookingRefusalCopy(DenialReason.GYM_CLOSED, null)).toBe(
      DENIAL_MEMBER_COPY[DenialReason.GYM_CLOSED],
    );
  });
});
