import { asCivilDate } from '../common/time/gym-time';
import {
  bookingAddedNotice,
  bookingRemovedNotice,
  classCancelledNotices,
  classChanged,
  classChangedNotices,
  classPromotedNotices,
  gymDayLabel,
  type ChangeableSession,
} from './class-notices';

const TZ = 'Asia/Manila';
const MEMBER = '44444444-4444-4444-8444-000000000001';
const OTHER = '44444444-4444-4444-8444-000000000002';
const BOOKING = '55555555-5555-4555-8555-555555555555';

/** Wed 14 Oct 2026, 10:00–11:00 PM in Manila — the latest, longest clock time. */
const session = (over: Partial<ChangeableSession> = {}): ChangeableSession => ({
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Spin',
  startsAt: new Date('2026-10-14T14:00:00.000Z'),
  endsAt: new Date('2026-10-14T15:00:00.000Z'),
  businessDate: new Date('2026-10-14T00:00:00.000Z'),
  coachId: '11111111-1111-4111-8111-111111111111',
  coach: { firstName: 'Ana', lastName: 'Cruz' },
  ...over,
});

/** A day before the class above starts. */
const BEFORE = new Date('2026-10-13T14:00:00.000Z');

const length = (text: string): number => Array.from(text).length;

describe('gymDayLabel', () => {
  it('reads the weekday off the civil date, with no zone to drift it', () => {
    expect(gymDayLabel(asCivilDate('2026-10-14'))).toBe('Wed 14 Oct');
    expect(gymDayLabel(asCivilDate('2027-01-01'))).toBe('Fri 1 Jan');
  });
});

/**
 * MemberNoticesService cuts an over-long title from its END, so the class
 * title must give way first — never the day and time the member cannot work
 * out for themselves. 120 code points is the CHECK.
 */
describe('a notice title within its 120 characters', () => {
  const longest = 'X'.repeat(80); // the most ClassSession_title_sane allows

  it('cuts the class title, never the day and time', () => {
    const { title } = bookingAddedNotice(
      session({ title: longest }),
      { bookingId: BOOKING, userId: MEMBER, status: 'BOOKED', waitlistPosition: null },
      BEFORE,
      TZ,
    );
    expect(length(title)).toBe(120);
    expect(title.startsWith('Booked by the desk: XXX')).toBe(true);
    expect(title.endsWith('…, Wed 14 Oct 10:00 PM')).toBe(true);
  });

  it('counts an emoji as one character, as char_length does', () => {
    const { title } = bookingAddedNotice(
      session({ title: '🔥'.repeat(80) }),
      { bookingId: BOOKING, userId: MEMBER, status: 'WAITLISTED', waitlistPosition: 12 },
      BEFORE,
      TZ,
    );
    expect(length(title)).toBe(120);
    expect(title.startsWith('The desk put you on the waitlist (#12): 🔥')).toBe(true);
    expect(title.endsWith('…, Wed 14 Oct 10:00 PM')).toBe(true);
  });

  it('leaves a title that fits alone', () => {
    const [notice] = classPromotedNotices(
      session(),
      [{ bookingId: BOOKING, userId: MEMBER }],
      new Date(0),
      TZ,
    );
    expect(notice?.title).toBe("You're in: Spin, Wed 14 Oct 10:00 PM");
  });
});

describe('who is told, and once', () => {
  it('sends one cancellation per member, however often they appear', () => {
    const notices = classCancelledNotices(session(), [MEMBER, OTHER, MEMBER], 'Flooded studio', TZ);
    expect(notices.map((notice) => notice.userId)).toEqual([MEMBER, OTHER]);
    expect(notices[0]?.body).toBe('Flooded studio');
  });

  it('puts no queue place on a waitlist add that has none', () => {
    const { title } = bookingAddedNotice(
      session(),
      { bookingId: BOOKING, userId: MEMBER, status: 'WAITLISTED', waitlistPosition: null },
      BEFORE,
      TZ,
    );
    expect(title).toBe('The desk put you on the waitlist: Spin, Wed 14 Oct 10:00 PM');
  });

  // A member's cancel is refused from the start, so the advice to cancel is
  // only there while it can be taken.
  it.each([
    [
      'before the start',
      new Date('2026-10-14T13:59:00.000Z'),
      "The desk booked you a place. Can't make it? Cancel so someone else can have it.",
    ],
    [
      'at the start',
      new Date('2026-10-14T14:00:00.000Z'),
      'The desk booked you a place in this class.',
    ],
    [
      'during the class — a walk-in',
      new Date('2026-10-14T14:20:00.000Z'),
      'The desk booked you a place in this class.',
    ],
  ])('a seat added %s says so', (_when, addedAt, body) => {
    const notice = bookingAddedNotice(
      session(),
      { bookingId: BOOKING, userId: MEMBER, status: 'BOOKED', waitlistPosition: null },
      addedAt,
      TZ,
    );
    expect(notice).toMatchObject({
      title: 'Booked by the desk: Spin, Wed 14 Oct 10:00 PM',
      body,
      dedupeKey: `BOOKING_ADDED:${BOOKING}:BOOKED`,
    });
  });

  it('tells a waitlist add the queue moves up by itself until the cutoff', () => {
    const { body } = bookingAddedNotice(
      session(),
      { bookingId: BOOKING, userId: MEMBER, status: 'WAITLISTED', waitlistPosition: 3 },
      BEFORE,
      TZ,
    );
    expect(body).toBe(
      "When a place opens up before 8:00 PM, the waitlist moves up by itself and we'll tell you here. After that, a free place goes to whoever books it first.",
    );
  });

  it('gives a removal the reason as its body, keyed on the booking', () => {
    expect(
      bookingRemovedNotice(session(), { bookingId: BOOKING, userId: MEMBER }, 'Unpaid', TZ),
    ).toMatchObject({ body: 'Unpaid', dedupeKey: `BOOKING_REMOVED:${BOOKING}` });
  });
});

describe('CLASS_CHANGED — only what a place depends on', () => {
  it('counts the time, the coach and the title, and nothing else', () => {
    const before = session();
    expect(classChanged(before, session())).toBe(false);
    expect(classChanged(before, session({ endsAt: new Date('2026-10-14T15:30:00.000Z') }))).toBe(
      true,
    );
    expect(classChanged(before, session({ coachId: 'c2' }))).toBe(true);
    expect(classChanged(before, session({ title: 'Spin Express' }))).toBe(true);
  });

  it('says nothing when nothing a member cares about changed', () => {
    expect(classChangedNotices(session(), session(), [MEMBER], new Date(0), TZ)).toEqual([]);
  });

  it('names the class by its old day, and the new day in the body', () => {
    const [notice] = classChangedNotices(
      session(),
      session({
        startsAt: new Date('2026-10-15T10:00:00.000Z'),
        endsAt: new Date('2026-10-15T11:00:00.000Z'),
        businessDate: new Date('2026-10-15T00:00:00.000Z'),
      }),
      [MEMBER],
      new Date(0),
      TZ,
    );
    expect(notice?.title).toBe('Changed: Spin, Wed 14 Oct');
    expect(notice?.body).toBe(
      'It now runs Thu 15 Oct, 6:00 PM to 7:00 PM. If that no longer works for you, cancel so someone else can have the place.',
    );
    expect(notice?.linkPath).toBe('/portal/book?date=2026-10-15');
  });

  // A running class can still have its end moved; its members can no longer
  // cancel, so they are told the new time and nothing else.
  it('advises cancelling only while the class has not started', () => {
    const later = session({ endsAt: new Date('2026-10-14T15:30:00.000Z') });
    const body = (editedAt: Date): string | null | undefined =>
      classChangedNotices(session(), later, [MEMBER], editedAt, TZ)[0]?.body;

    expect(body(new Date('2026-10-14T13:59:59.999Z'))).toBe(
      'It now runs Wed 14 Oct, 10:00 PM to 11:30 PM. If that no longer works for you, cancel so someone else can have the place.',
    );
    expect(body(new Date('2026-10-14T14:00:00.000Z'))).toBe(
      'It now runs Wed 14 Oct, 10:00 PM to 11:30 PM.',
    );
    expect(body(new Date('2026-10-14T14:40:00.000Z'))).toBe(
      'It now runs Wed 14 Oct, 10:00 PM to 11:30 PM.',
    );
  });

  // Judged on the NEW start, which is the one a member's cancel is checked
  // against: a start pushed back past the moment of the edit can still be
  // cancelled.
  it('judges the advice on the class as it now runs', () => {
    const [notice] = classChangedNotices(
      session(),
      session({
        startsAt: new Date('2026-10-14T14:30:00.000Z'),
        endsAt: new Date('2026-10-14T15:30:00.000Z'),
      }),
      [MEMBER],
      new Date('2026-10-14T14:10:00.000Z'),
      TZ,
    );
    expect(notice?.body).toBe(
      'It now runs Wed 14 Oct, 10:30 PM to 11:30 PM. If that no longer works for you, cancel so someone else can have the place.',
    );
  });

  // Pure: the same edit, described twice, is the same notice.
  it('reads no clock: the same inputs give the same notice', () => {
    const args = [
      session(),
      session({ title: 'Spin Express' }),
      [MEMBER],
      new Date(1),
      TZ,
    ] as const;
    expect(classChangedNotices(...args)).toEqual(classChangedNotices(...args));
  });
});
