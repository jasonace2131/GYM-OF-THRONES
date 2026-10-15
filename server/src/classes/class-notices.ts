import { createHash } from 'node:crypto';
import { waitlistClosesAt } from '@got/shared';
import type { MemberNoticeInput } from '../notifications/member-notices.service';
import {
  civilDateFromPrisma,
  gymClockTime,
  shortDate,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';

/**
 * What a member is told when something happens to their place in a class —
 * the text of every notice the class paths send (owner defaults, 2026-10-11:
 * in-app only, the member's bell).
 *
 * PURE, like the presenters: no clock, no database. Each producer passes the
 * instant it acted at and the gym's zone, so a notice says exactly what the
 * write did, in the gym's time — a member reading "6:00 PM" on a phone set to
 * another zone is reading the class's time, which is the time that matters.
 *
 * Every notice is a complete line composed now and stored as sent
 * (MemberNotice's own rule): the bell shows what the member was told, even
 * after the class changes again.
 *
 * Each carries a dedupe key, because notices are written with
 * createMany({ skipDuplicates: true }): a key already in the table is skipped,
 * so a retried request notifies once. A key must therefore name one EVENT,
 * never just one booking — two different things that happen to the same
 * booking need two keys, or the second notice is silently dropped.
 */

/** What every notice needs to know about the class it is about. */
export interface NoticeSession {
  id: string;
  title: string;
  startsAt: Date;
  /** The `@db.Date` column as Prisma returns it — UTC midnight of the gym day. */
  businessDate: Date;
}

/** What a time, coach or title change is judged on, before and after. */
export interface ChangeableSession extends NoticeSession {
  endsAt: Date;
  coachId: string;
  coach: { firstName: string; lastName: string };
}

/** A waitlisted booking the seat-changing paths moved into a seat. */
export interface PromotedPlace {
  bookingId: string;
  userId: string;
}

/** MemberNotice_title_sane's bound, in characters (code points) after trimming. */
const TITLE_MAX = 120;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * A gym day as a person reads it: '2026-10-14' → 'Wed 14 Oct'.
 *
 * The weekday is read off the civil date at UTC midnight — no zone involved,
 * which is the whole point of a civil date — so it cannot drift a day.
 */
export function gymDayLabel(day: CivilDate): string {
  return `${WEEKDAYS[toDateColumn(day).getUTCDay()]} ${shortDate(day)}`;
}

/** Where every class notice takes the member: that day on the timetable. */
function classLink(session: Pick<NoticeSession, 'businessDate'>): string {
  return `/portal/book?date=${civilDateFromPrisma(session.businessDate)}`;
}

/** 'Wed 14 Oct 6:00 PM' — the day and start time a member knows the class by. */
function when(session: Pick<NoticeSession, 'startsAt' | 'businessDate'>, timeZone: string): string {
  return `${gymDayLabel(civilDateFromPrisma(session.businessDate))} ${gymClockTime(session.startsAt, timeZone)}`;
}

/**
 * `prefix` + the class title + `suffix`, within the notice title's 120.
 *
 * The CLASS TITLE gives way, never the day or the time: MemberNoticesService
 * cuts an over-long line from its END, and "Booked by the desk: {80 characters}
 * , Wed 14 Oct 10:00 PM" is already over — the cut would fall on the time, the
 * one part of the line the member cannot work out for themselves. Counted in
 * code points, which is what the CHECK's char_length counts.
 */
function titled(prefix: string, classTitle: string, suffix: string): string {
  const room = TITLE_MAX - Array.from(prefix).length - Array.from(suffix).length;
  const chars = Array.from(classTitle.trim());
  const fitted =
    chars.length <= room
      ? chars.join('')
      : `${chars
          .slice(0, Math.max(1, room - 1))
          .join('')
          .trimEnd()}…`;
  return `${prefix}${fitted}${suffix}`;
}

/**
 * The waitlist moved these members into seats (CLASS_PROMOTED).
 *
 * Keyed on the booking AND the promotion instant: a booking is promoted at
 * most once — nothing moves a seat back to the waitlist — so the pair names
 * this one event.
 */
export function classPromotedNotices(
  session: NoticeSession,
  promoted: readonly PromotedPlace[],
  promotedAt: Date,
  timeZone: string,
): MemberNoticeInput[] {
  return promoted.map((place) => ({
    userId: place.userId,
    kind: 'CLASS_PROMOTED',
    title: titled("You're in: ", session.title, `, ${when(session, timeZone)}`),
    body: "A place opened up and it's yours. Can't make it? Cancel so the next person gets it.",
    linkPath: classLink(session),
    subjectType: 'ClassBooking',
    subjectId: place.bookingId,
    dedupeKey: `CLASS_PROMOTED:${place.bookingId}:${promotedAt.getTime()}`,
  }));
}

/**
 * The gym called the class off (CLASS_CANCELLED), with the reason staff gave
 * as the body. A class is cancelled at most once, so session and member are
 * the whole key.
 */
export function classCancelledNotices(
  session: NoticeSession,
  userIds: readonly string[],
  reason: string,
  timeZone: string,
): MemberNoticeInput[] {
  return [...new Set(userIds)].map((userId) => ({
    userId,
    kind: 'CLASS_CANCELLED',
    title: titled('Cancelled: ', session.title, `, ${when(session, timeZone)}`),
    body: reason,
    linkPath: classLink(session),
    subjectType: 'ClassSession',
    subjectId: session.id,
    dedupeKey: `CLASS_CANCELLED:${session.id}:${userId}`,
  }));
}

/**
 * Whether an edit changed something a member holding a place must hear about:
 * when it runs, who runs it, or what it is called. Capacity and the
 * description are the gym's business — nobody's place depends on them.
 */
export function classChanged(before: ChangeableSession, after: ChangeableSession): boolean {
  return (
    before.startsAt.getTime() !== after.startsAt.getTime() ||
    before.endsAt.getTime() !== after.endsAt.getTime() ||
    before.coachId !== after.coachId ||
    before.title !== after.title
  );
}

/**
 * The time, coach or title changed (CLASS_CHANGED). Empty when nothing a
 * member cares about did.
 *
 * The title names the class as the member KNEW it — its old name and day — and
 * the body says what is new, in full, so the notice still makes sense next to
 * a timetable that has already moved on.
 *
 * The key carries the new values, as the spec asks, AND the instant of the
 * edit. The values alone would swallow a flip-flop: coach A → B → A → B sends
 * "now B" twice, and the second is the one the member needs.
 */
export function classChangedNotices(
  before: ChangeableSession,
  after: ChangeableSession,
  userIds: readonly string[],
  editedAt: Date,
  timeZone: string,
): MemberNoticeInput[] {
  if (!classChanged(before, after)) return [];

  const timeMoved =
    before.startsAt.getTime() !== after.startsAt.getTime() ||
    before.endsAt.getTime() !== after.endsAt.getTime();
  const day = gymDayLabel(civilDateFromPrisma(after.businessDate));

  const lines: string[] = [];
  if (timeMoved) {
    lines.push(
      `It now runs ${day}, ${gymClockTime(after.startsAt, timeZone)} to ${gymClockTime(after.endsAt, timeZone)}.`,
    );
  }
  if (before.coachId !== after.coachId) {
    lines.push(`Your coach is now ${`${after.coach.firstName} ${after.coach.lastName}`.trim()}.`);
  }
  if (before.title !== after.title) lines.push(`It is now called ${after.title}.`);
  // Only while the member can still act on it: a member's cancel is refused
  // once the class has started, and a running class can still have its end
  // moved.
  if (timeMoved && editedAt < after.startsAt) {
    lines.push('If that no longer works for you, cancel so someone else can have the place.');
  }

  const titleHash = createHash('sha256').update(after.title).digest('hex').slice(0, 12);
  const values = [after.startsAt.getTime(), after.endsAt.getTime(), after.coachId, titleHash];

  return [...new Set(userIds)].map((userId) => ({
    userId,
    kind: 'CLASS_CHANGED',
    title: titled(
      'Changed: ',
      before.title,
      `, ${gymDayLabel(civilDateFromPrisma(before.businessDate))}`,
    ),
    body: lines.join(' '),
    linkPath: classLink(after),
    subjectType: 'ClassSession',
    subjectId: after.id,
    dedupeKey: `CLASS_CHANGED:${after.id}:${userId}:${values.join(':')}:${editedAt.getTime()}`,
  }));
}

/** A place the desk booked by hand, as the member is told it. */
export interface AddedPlace {
  bookingId: string;
  userId: string;
  /** Where the add left them: in a seat, or on the waitlist. */
  status: 'BOOKED' | 'WAITLISTED';
  /** Their place in the queue, when WAITLISTED. */
  waitlistPosition: number | null;
}

/**
 * The desk booked the member in, or put them on the waitlist (BOOKING_ADDED).
 *
 * Keyed on the booking AND where it left them. The desk can add somebody to
 * the waitlist and later move the same booking into a seat; a key on the
 * booking alone would skip the second notice — the one that says they are in.
 *
 * `addedAt` is the instant of the add. A seat added once the class has
 * started — a walk-in joining a running class — carries no advice to cancel:
 * a member's cancel is refused from the start, so the line would send them to
 * a button that says no. (A waitlist add is always before the start: the
 * waitlist closes first.)
 */
export function bookingAddedNotice(
  session: NoticeSession,
  place: AddedPlace,
  addedAt: Date,
  timeZone: string,
): MemberNoticeInput {
  const suffix = `, ${when(session, timeZone)}`;
  const seated = place.status === 'BOOKED';
  const queue = place.waitlistPosition === null ? '' : ` (#${place.waitlistPosition})`;
  const running = addedAt >= session.startsAt;

  return {
    userId: place.userId,
    kind: 'BOOKING_ADDED',
    title: seated
      ? titled('Booked by the desk: ', session.title, suffix)
      : titled(`The desk put you on the waitlist${queue}: `, session.title, suffix),
    body: seated
      ? running
        ? 'The desk booked you a place in this class.'
        : "The desk booked you a place. Can't make it? Cancel so someone else can have it."
      : `When a place opens up before ${gymClockTime(waitlistClosesAt(session.startsAt), timeZone)}, the waitlist moves up by itself and we'll tell you here. After that, a free place goes to whoever books it first.`,
    linkPath: classLink(session),
    subjectType: 'ClassBooking',
    subjectId: place.bookingId,
    dedupeKey: `BOOKING_ADDED:${place.bookingId}:${place.status}`,
  };
}

/**
 * The desk took the member out of the class (BOOKING_REMOVED), with the
 * reason they gave as the body. A booking is removed at most once — it is
 * CANCELLED afterwards — so the booking is the whole key.
 */
export function bookingRemovedNotice(
  session: NoticeSession,
  place: { bookingId: string; userId: string },
  reason: string,
  timeZone: string,
): MemberNoticeInput {
  return {
    userId: place.userId,
    kind: 'BOOKING_REMOVED',
    title: titled('Removed from ', session.title, `, ${when(session, timeZone)}`),
    body: reason,
    linkPath: classLink(session),
    subjectType: 'ClassBooking',
    subjectId: place.bookingId,
    dedupeKey: `BOOKING_REMOVED:${place.bookingId}`,
  };
}
