import type {
  BookingCanceller,
  BookingStatus,
  ClassRegisterEntryWire,
  ClassSessionWire,
  MarkAttendanceResultWire,
  MyBookingWire,
} from '@got/shared';
import { civilDateFromPrisma, type CivilDate } from '../common/time/gym-time';

/**
 * Classes on the wire.
 *
 * Instants go out as ISO strings, never pre-formatted — every surface renders
 * its own with an explicit `timeZone`. The same rule money follows with
 * centavos, and for the same reason: a formatted time in a response body is a
 * time formatted in the SERVER's zone and shipped to a phone in another one.
 */

export interface ClassSessionRow {
  id: string;
  title: string;
  description: string | null;
  coachId: string;
  startsAt: Date;
  endsAt: Date;
  businessDate: Date;
  capacity: number;
  bookedCount: number;
  cancelledAt: Date | null;
  cancelReason: string | null;
  coach: { firstName: string; lastName: string };
  /**
   * The session's WAITLISTED bookings, counted in the same query that loaded
   * the row — Prisma's filtered relation count, `SESSION_INCLUDE` in
   * class-queries.ts:
   *
   *   `_count: { select: { bookings: { where: { status: 'WAITLISTED' } } } }`
   *
   * REQUIRED, so the compiler proves every path that answers with a session
   * loaded it. A fallback of 0 would be a plausible-looking number on a screen
   * where nobody could tell it was never counted.
   */
  _count: { bookings: number };
}

export interface ClassSessionDto {
  id: string;
  title: string;
  description: string | null;
  /**
   * The coach's user id, alongside their name.
   *
   * Both, deliberately. `coachName` is what every surface RENDERS; `coachId`
   * is what the console's edit form needs to preselect the coach dropdown, and
   * matching on a display name to recover an id is how two coaches called
   * Santos end up swapping timetables. It exposes nothing the name does not —
   * the timetable already tells every member who is teaching.
   */
  coachId: string;
  coachName: string;
  startsAt: string;
  endsAt: string;
  businessDate: CivilDate;
  capacity: number;
  /** Seats taken. Never exceeds `capacity` — a database CHECK guarantees it. */
  bookedCount: number;
  /** Derived once here so no two screens can disagree about "full". */
  seatsLeft: number;
  isFull: boolean;
  /** People on the waitlist — a count, never who they are. */
  waitlistCount: number;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export function toClassSession(row: ClassSessionRow): ClassSessionDto {
  const seatsLeft = Math.max(0, row.capacity - row.bookedCount);

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    coachId: row.coachId,
    coachName: `${row.coach.firstName} ${row.coach.lastName}`.trim(),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    // The ONLY sanctioned way to read a @db.Date back — it arrives at UTC
    // midnight and any other accessor is a day out for half the year.
    businessDate: civilDateFromPrisma(row.businessDate),
    capacity: row.capacity,
    bookedCount: row.bookedCount,
    seatsLeft,
    isFull: seatsLeft === 0,
    waitlistCount: row._count.bookings,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
  };
}

export interface MyBookingRow {
  id: string;
  /** Whose booking this is — what tells their own cancellation from the gym's. */
  userId: string;
  status: string;
  bookedAt: Date;
  promotedAt: Date | null;
  attendedAt: Date | null;
  cancelledAt: Date | null;
  bookedById: string | null;
  cancelledById: string | null;
  removalReason: string | null;
  session: ClassSessionRow;
}

export interface MyBooking {
  bookingId: string;
  status: BookingStatus;
  bookedAt: string;
  /**
   * Set when the member was moved off the waitlist into a seat for them — by a
   * freed seat or by the desk. Null when they booked straight in, or took a
   * freed seat themselves.
   */
  promotedAt: string | null;
  attendedAt: string | null;
  cancelledAt: string | null;
  /** 1-based place in the queue; null unless WAITLISTED (see `toMyBooking`). */
  waitlistPosition: number | null;
  cancelledBy: BookingCanceller | null;
  removalReason: string | null;
  addedByStaff: boolean;
  session: ClassSessionDto;
}

/**
 * Who cancelled a booking, as its member is told it — null unless CANCELLED.
 *
 * GYM only when somebody OTHER than the member is recorded: a desk user taking
 * them out. The member's own id is a self-cancel, and so is no id at all —
 * every cancellation written before the canceller was recorded, when the
 * member was the only person who could cancel.
 */
export function bookingCancelledBy(
  row: Pick<MyBookingRow, 'status' | 'userId' | 'cancelledById'>,
): BookingCanceller | null {
  if (row.status !== 'CANCELLED') return null;
  return row.cancelledById !== null && row.cancelledById !== row.userId ? 'GYM' : 'MEMBER';
}

/**
 * Whether the desk booked this place for the member, by hand.
 *
 * Only staff adds record a booker, so "a booker is recorded" is the rule. The
 * member's own id is excluded as well, so a self-booking that ever records its
 * booker cannot read as the desk's.
 */
export function bookingAddedByStaff(row: Pick<MyBookingRow, 'userId' | 'bookedById'>): boolean {
  return row.bookedById !== null && row.bookedById !== row.userId;
}

/**
 * `timeZone` is accepted and deliberately unused for formatting — it is here
 * so the signature does not change when a future caller needs it, and so this
 * file never grows a `toLocaleString` that bakes a zone into the payload.
 *
 * `waitlistPosition` is computed by the caller, which has the rest of the
 * queue in hand: 1-based, in the order the waitlist is served (bookedAt, then
 * id). The caller also passes null once the waitlist has closed — that needs
 * the clock, which this file never reads. A position on a row that is not
 * WAITLISTED is dropped here: it would describe a queue the member is not in.
 */
export function toMyBooking(
  row: MyBookingRow,
  _timeZone: string,
  waitlistPosition: number | null = null,
): MyBooking {
  const cancelledBy = bookingCancelledBy(row);

  return {
    bookingId: row.id,
    // The Prisma enum and BookingStatus are the same five literals.
    status: row.status as BookingStatus,
    bookedAt: row.bookedAt.toISOString(),
    promotedAt: row.promotedAt?.toISOString() ?? null,
    attendedAt: row.attendedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    waitlistPosition: row.status === 'WAITLISTED' ? waitlistPosition : null,
    cancelledBy,
    // Only the desk gives a reason, and only the member it removed is shown it.
    removalReason: cancelledBy === 'GYM' ? row.removalReason : null,
    addedByStaff: bookingAddedByStaff(row),
    session: toClassSession(row.session),
  };
}

/** A person's name as the register shows it — never their contact details. */
interface PersonName {
  firstName: string;
  lastName: string;
}

/** One booking as the register reads it (`REGISTER_SELECT` in class-queries.ts). */
export interface RegisterRow {
  id: string;
  userId: string;
  status: string;
  bookedAt: Date;
  bookedById: string | null;
  markedAt: Date | null;
  user: PersonName & { memberCode: string | null };
  markedBy: PersonName | null;
}

/**
 * The shared register row — the one shape the console and the coach both read.
 * An alias rather than a server-side twin with an `assert…Wire` below: the
 * presenter returns an object literal of this type, so the compiler already
 * checks every field against the contract, extra ones included.
 */
export type ClassRegisterEntry = ClassRegisterEntryWire;

/**
 * One register row. `waitlistPosition` is the caller's, exactly as for
 * `toMyBooking`: it has the queue in hand. Unlike the member's own view, staff
 * keep the queue order after the waitlist closes — "who was first" is still
 * the desk's question when a place frees up by the counter.
 *
 * Explicit field lists all the way down: `user` and `markedBy` come from
 * relation selects, and spreading them would ship whatever a later select
 * adds (an email, a phone) to every coach's screen.
 */
export function toClassRegisterEntry(
  row: RegisterRow,
  waitlistPosition: number | null = null,
): ClassRegisterEntry {
  return {
    bookingId: row.id,
    // The Prisma enum and BookingStatus are the same five literals.
    status: row.status as BookingStatus,
    bookedAt: row.bookedAt.toISOString(),
    waitlistPosition: row.status === 'WAITLISTED' ? waitlistPosition : null,
    addedByStaff: bookingAddedByStaff(row),
    markedAt: row.markedAt?.toISOString() ?? null,
    markedBy:
      row.markedBy === null
        ? null
        : { firstName: row.markedBy.firstName, lastName: row.markedBy.lastName },
    member: {
      firstName: row.user.firstName,
      lastName: row.user.lastName,
      memberCode: row.user.memberCode,
    },
  };
}

/** The row a marking UPDATE hands back (`MARKED_SELECT` in class-queries.ts). */
export interface MarkedRow {
  id: string;
  status: string;
  markedAt: Date | null;
  markedBy: PersonName | null;
}

/** The shared answer to a marking, aliased for the same reason as ClassRegisterEntry. */
export type MarkAttendanceResult = MarkAttendanceResultWire;

/**
 * What marking one entry answers: the outcome, who recorded it and when — so a
 * row the screen patches in place reads exactly as a reload would.
 *
 * The row is the one the marking UPDATE itself returned, so both marker
 * columns were written by that statement and the marker's FK is RESTRICT.
 * Checked rather than asserted with `!`: a regression then fails loudly here
 * instead of sending a register "Marked by null".
 */
export function toMarkAttendanceResult(row: MarkedRow): MarkAttendanceResult {
  if (row.markedAt === null || row.markedBy === null) {
    throw new Error(`booking ${row.id} came back from its marking without a marker`);
  }
  if (row.status !== 'ATTENDED' && row.status !== 'NO_SHOW') {
    throw new Error(`booking ${row.id} came back from its marking as ${row.status}`);
  }
  return {
    bookingId: row.id,
    status: row.status,
    markedAt: row.markedAt.toISOString(),
    markedBy: { firstName: row.markedBy.firstName, lastName: row.markedBy.lastName },
  };
}

// Compile-time guarantee that the server's shapes satisfy the shared wire
// contract the client imports. If a field drifts, this file stops compiling.
export const assertClassSessionWire = (dto: ClassSessionDto): ClassSessionWire => dto;
export const assertMyBookingWire = (dto: MyBooking): MyBookingWire => dto;
