// Imported from gymTime and schedule/, never from classes.ts or adminApi.ts at
// runtime: both pull in the Supabase client, which would make these pure
// helpers unloadable in a unit test. `MemberListItem` is a type-only import.
import {
  MembershipStatus,
  registerOpensAt,
  waitlistClosesAt,
  type ClassRegisterEntryWire,
  type ClassSessionWire,
  type MarkAttendanceResultWire,
} from '@got/shared';
import type { MemberListItem } from './adminApi';
import { formatCivilDate } from './gymTime';
import { gymClock12, gymParts } from './schedule/gymClock';
import { shortDay } from './schedule/labels';

/**
 * A class register, as both staff surfaces read it — the console's (desk and
 * admin) and the coach's dashboard.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A ROW SAYS IS DECIDED ONCE, HERE. HOW IT IS WRITTEN IS NOT.
 *
 * The two registers differ on purpose: the console confirms every mark and
 * reloads, the coach marks in one tap and patches the row in place. They used
 * to differ by accident as well — the same waitlist row was an amber badge on
 * one and a blue one on the other, and only the console could tell a marked
 * row from an unmarked one. The words and tones now come from here.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure: no fetch, and no clock of its own. `now` is always passed in by a
 * component that ticks it, so a register left open on a counter all day still
 * changes its answer when the class starts.
 */

/** The portal's badge tones — structurally the same as `BadgeTone`. */
export type RegisterTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export interface RegisterBadge {
  label: string;
  tone: RegisterTone;
}

/** Whether the register can be marked yet. The server refuses earlier marks. */
export function registerIsOpen(startsAt: string, now: Date): boolean {
  return now.getTime() >= registerOpensAt(startsAt).getTime();
}

// ── The deploy window ───────────────────────────────────────────────────────
//
// Vercel usually goes live before Render, so for a few minutes after a push
// this console talks to the API it replaced. That API's register rows are
// `{ bookingId, status, member }` and nothing else, and its mark answer is
// `{ bookingId, status }`. Read raw, `markedBy.firstName` threw and took the
// whole register down, and a queue place rendered as "#undefined". Both
// wrappers (`adminApi`, `coachApi`) pass every answer through these, so a
// field the server did not send arrives as the "nothing to say" value every
// screen already handles. The helpers below compare with `== null` as well,
// for any caller that reaches them another way.

/** A register row as an API of either age sends it. */
export type RegisterEntryReply = Pick<ClassRegisterEntryWire, 'bookingId' | 'status' | 'member'> &
  Partial<ClassRegisterEntryWire>;

/**
 * Every field listed, rather than spread: a field added to the wire type later
 * fails to compile here until somebody decides what an older API means by it.
 */
export function registerEntryFromWire(raw: RegisterEntryReply): ClassRegisterEntryWire {
  return {
    bookingId: raw.bookingId,
    status: raw.status,
    // No screen reads it. An empty string is an Invalid Date wherever it
    // might one day be read, rather than an invented time.
    bookedAt: raw.bookedAt ?? '',
    waitlistPosition: raw.waitlistPosition ?? null,
    addedByStaff: raw.addedByStaff ?? false,
    markedAt: raw.markedAt ?? null,
    markedBy: raw.markedBy ?? null,
    member: raw.member,
  };
}

/** A mark as the registers keep it: the outcome, and who made it when the API said. */
export type MarkResult = Pick<MarkAttendanceResultWire, 'bookingId' | 'status'> &
  Pick<ClassRegisterEntryWire, 'markedAt' | 'markedBy'>;

/** A mark's answer as an API of either age sends it. */
export type MarkResultReply = Pick<MarkAttendanceResultWire, 'bookingId' | 'status'> &
  Partial<MarkAttendanceResultWire>;

export function markResultFromWire(raw: MarkResultReply): MarkResult {
  return {
    bookingId: raw.bookingId,
    status: raw.status,
    markedAt: raw.markedAt ?? null,
    markedBy: raw.markedBy ?? null,
  };
}

/**
 * The badge on one register row, or null for a seated member not yet marked.
 *
 * A waitlist row carries its queue place ("Waitlist · #2") until the class
 * starts. From then on the queue can never become a seat — nobody is promoted
 * after the waitlist closes, and a running class takes no waitlist places — so
 * the row reads "No place". Neutral, and deliberately not "No show": the
 * member never had a seat to miss. Display only; the row stays WAITLISTED
 * (owner default, 2026-10-11).
 */
export function registerBadge(
  entry: Pick<ClassRegisterEntryWire, 'status' | 'waitlistPosition'>,
  startsAt: string,
  now: Date,
): RegisterBadge | null {
  switch (entry.status) {
    case 'WAITLISTED':
      if (now.getTime() >= new Date(startsAt).getTime()) {
        return { label: 'No place', tone: 'neutral' };
      }
      return {
        label:
          entry.waitlistPosition == null ? 'Waitlist' : `Waitlist · #${entry.waitlistPosition}`,
        tone: 'warn',
      };
    case 'ATTENDED':
      return { label: 'Here', tone: 'ok' };
    case 'NO_SHOW':
      return { label: 'No show', tone: 'neutral' };
    default:
      // BOOKED, still to be marked. CANCELLED never reaches a register.
      return null;
  }
}

/**
 * "Marked by Ana Cruz · 6:42 PM" — who last marked the entry, and when, in
 * gym time.
 *
 * The day is added when the mark was made on a different day from the class
 * — a register put right the next morning — so a late correction never reads
 * as though it happened while the class was running.
 *
 * Null for an entry never marked, and for one marked before the system
 * recorded markers: there is nothing true to say about those. A time with no
 * marker reads "Marked 6:42 PM".
 */
export function markedByLine(
  entry: Pick<ClassRegisterEntryWire, 'markedAt' | 'markedBy'>,
  classDay: string,
): string | null {
  if (entry.markedAt == null) return null;
  const day = gymParts(entry.markedAt).date;
  const time = gymClock12(entry.markedAt);
  const when = day === classDay ? time : `${shortDay(day)}, ${time}`;
  return entry.markedBy == null
    ? `Marked ${when}`
    : `Marked by ${entry.markedBy.firstName} ${entry.markedBy.lastName} · ${when}`;
}

/**
 * The console register's note for the stretch between the waitlist closing
 * and the class starting — the only time a freed place does NOT go to the
 * queue by itself (owner, 2026-10-11). Null outside that stretch, and when
 * nobody is waiting, because then there is nothing for the desk to decide.
 */
export function waitlistClosedNote(startsAt: string, waiting: number, now: Date): string | null {
  if (waiting === 0) return null;
  const closes = waitlistClosesAt(startsAt);
  if (now.getTime() < closes.getTime() || now.getTime() >= new Date(startsAt).getTime()) {
    return null;
  }
  return `The waitlist closed at ${gymClock12(closes)}. Nobody moves up by themselves now: a free place goes to whoever books it first, or to somebody the desk adds.`;
}

/**
 * How many people are still waiting for a place — the console's "· 3 waiting".
 *
 * Zero once the class has started, when every one of those rows reads "No
 * place" on the register (`registerBadge`), and for a class the gym called
 * off. A count beside either would describe a queue that can no longer move.
 */
export function stillWaiting(
  session: Pick<ClassSessionWire, 'startsAt' | 'cancelledAt' | 'waitlistCount'>,
  now: Date,
): number {
  if (session.cancelledAt !== null) return 0;
  if (now.getTime() >= new Date(session.startsAt).getTime()) return 0;
  return session.waitlistCount;
}

/**
 * The class with its counts taken from a register just loaded, rather than
 * from the timetable row it was opened from.
 *
 * The row is as old as the page. A member who cancelled since — after the
 * waitlist closed, say — left a free seat that the register shows and the row
 * does not, and the desk's add preview read "Full, and the waitlist has
 * closed" beside an empty place. Seats are every row that is neither waiting
 * nor cancelled (a marked row still holds its seat), as the server counts them.
 */
export function withRegisterCounts<S extends Pick<ClassSessionWire, 'capacity'>>(
  session: S,
  rows: readonly Pick<ClassRegisterEntryWire, 'status'>[],
): S & Pick<ClassSessionWire, 'bookedCount' | 'seatsLeft' | 'isFull' | 'waitlistCount'> {
  const seated = rows.filter(
    (entry) => entry.status !== 'WAITLISTED' && entry.status !== 'CANCELLED',
  ).length;
  const waiting = rows.filter((entry) => entry.status === 'WAITLISTED').length;
  return {
    ...session,
    bookedCount: seated,
    seatsLeft: Math.max(0, session.capacity - seated),
    isFull: seated >= session.capacity,
    waitlistCount: waiting,
  };
}

/**
 * What adding somebody to this class would do right now — the desk's preview.
 * The server decides again, under a lock on the class, so a place taken in
 * the meantime turns a SEAT into a waitlist place or a refusal, never an
 * overbooking.
 *
 *   SEAT             a place is free: booked straight in (a walk-in may join
 *                    a class that is already running);
 *   WAITLIST         full, and the waitlist is still open;
 *   WAITLIST_CLOSED  full, and the waitlist has closed (or the class has
 *                    started) — the places have to be raised first;
 *   FINISHED         the class has ended;
 *   CANCELLED        the gym called it off.
 */
export type StaffAddOutcome = 'SEAT' | 'WAITLIST' | 'WAITLIST_CLOSED' | 'FINISHED' | 'CANCELLED';

export function staffAddOutcome(
  session: Pick<ClassSessionWire, 'startsAt' | 'endsAt' | 'seatsLeft' | 'cancelledAt'>,
  now: Date,
): StaffAddOutcome {
  if (session.cancelledAt !== null) return 'CANCELLED';
  if (now.getTime() >= new Date(session.endsAt).getTime()) return 'FINISHED';
  if (session.seatsLeft > 0) return 'SEAT';
  // The cutoff falls before the start, so this also keeps a running class
  // from taking a waitlist place.
  return now.getTime() < waitlistClosesAt(session.startsAt).getTime()
    ? 'WAITLIST'
    : 'WAITLIST_CLOSED';
}

/**
 * Why the desk might think twice before adding this person.
 *
 *   NOT_A_MEMBER  a staff account — the server refuses it (MEMBER_NOT_BOOKABLE);
 *   ACCOUNT       suspended or deactivated — the door will not admit them;
 *   PLAN          their plan will not cover the class day.
 */
export type StaffAddConcern = 'NOT_A_MEMBER' | 'ACCOUNT' | 'PLAN';

export interface StaffAddCheck {
  concern: StaffAddConcern;
  /** True only when the server would refuse the add outright. */
  blocks: boolean;
  /** One sentence for the desk. */
  message: string;
}

/**
 * What the desk should know before adding `member` to a class on `classDay`
 * (both yyyy-mm-dd, as is `today`). Null when there is nothing to say.
 *
 * ONLY A STAFF ACCOUNT BLOCKS. Everything else is a heads-up, because a desk
 * add deliberately skips the plan rule members book under (owner, 2026-10-11)
 * — the person at the counter may know what the system does not, such as a
 * renewal being paid right now. The door still checks the plan on the day.
 *
 * Read from the roster row the picker already holds, so it costs no request.
 * That row carries no booked-in freezes, so a plan a scheduled freeze will
 * carry past the class can still be flagged: the warning says what the plan
 * says TODAY. "Covers the class day" is the server's rule — a plan counts
 * through its end date, grace days do not.
 */
export function staffAddCheck(
  member: Pick<MemberListItem, 'firstName' | 'role' | 'status' | 'membership'>,
  classDay: string,
  today: string,
): StaffAddCheck | null {
  const name = member.firstName;

  if (member.role !== 'CLIENT') {
    return {
      concern: 'NOT_A_MEMBER',
      blocks: true,
      message: `${name} has a staff account. Only members can be booked into a class.`,
    };
  }

  if (member.status === 'SUSPENDED') {
    return {
      concern: 'ACCOUNT',
      blocks: false,
      message: `${name}'s account is suspended, so the door will not let them in until that is lifted.`,
    };
  }
  if (member.status === 'DEACTIVATED') {
    return {
      concern: 'ACCOUNT',
      blocks: false,
      message: `${name}'s account is deactivated, so the door will not let them in.`,
    };
  }

  const plan = member.membership;
  if (plan === null) {
    return { concern: 'PLAN', blocks: false, message: `${name} has no plan to cover this class.` };
  }
  if (plan.status === MembershipStatus.CANCELLED) {
    return {
      concern: 'PLAN',
      blocks: false,
      message: `${name}'s plan was cancelled, so it does not cover this class.`,
    };
  }
  // yyyy-mm-dd strings order the same way the days do.
  if (plan.endsOn < classDay) {
    return {
      concern: 'PLAN',
      blocks: false,
      message:
        plan.endsOn < today
          ? `${name}'s plan ended ${formatCivilDate(plan.endsOn)}, so it does not cover this class.`
          : `${name}'s plan ends ${formatCivilDate(plan.endsOn)}, before this class.`,
    };
  }
  if (plan.status === MembershipStatus.FROZEN) {
    return {
      concern: 'PLAN',
      blocks: false,
      message: `${name}'s plan is paused right now. If it is still paused on ${shortDay(classDay)}, it does not cover this class.`,
    };
  }
  if (plan.status === MembershipStatus.EXPIRED) {
    return { concern: 'PLAN', blocks: false, message: `${name}'s plan has expired.` };
  }
  return null;
}
