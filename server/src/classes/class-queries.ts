import type { Prisma } from '@prisma/client';

/**
 * The query shapes and the row lock both class services share.
 *
 * One place, so the timetable and the booking paths cannot drift apart on what
 * "a session as the API answers it" loads — the waitlist count in particular,
 * which `ClassSessionRow._count` makes REQUIRED: a path that forgets it no
 * longer compiles.
 */

/**
 * Every interactive transaction that changes a seat. Eight seconds, like the
 * door's (check-in.service.ts): long enough for a promotion pass over a long
 * waitlist, short enough that a stuck lock frees the class for everybody else.
 */
export const SEAT_TX_OPTIONS = { timeout: 8_000 } as const;

/**
 * A session as every surface reads it: the coach's name, and how many people
 * are waiting — Prisma's filtered relation count, in the same query.
 */
export const SESSION_INCLUDE = {
  coach: { select: { firstName: true, lastName: true } },
  _count: { select: { bookings: { where: { status: 'WAITLISTED' } } } },
} satisfies Prisma.ClassSessionInclude;

/** A booking with its session, as the member's own views answer it. */
export const BOOKING_INCLUDE = {
  session: { include: SESSION_INCLUDE },
} satisfies Prisma.ClassBookingInclude;

/** A person's name, and nothing else about them. */
const NAME_SELECT = { firstName: true, lastName: true } satisfies Prisma.UserSelect;

/** One register entry (`RegisterRow` in class.presenter.ts). */
export const REGISTER_SELECT = {
  id: true,
  userId: true,
  status: true,
  bookedAt: true,
  bookedById: true,
  markedAt: true,
  user: { select: { ...NAME_SELECT, memberCode: true } },
  markedBy: { select: NAME_SELECT },
} satisfies Prisma.ClassBookingSelect;

/** What a marking UPDATE hands back (`MarkedRow` in class.presenter.ts). */
export const MARKED_SELECT = {
  id: true,
  status: true,
  markedAt: true,
  markedBy: { select: NAME_SELECT },
} satisfies Prisma.ClassBookingSelect;

/**
 * The order the waitlist is served in: joined earliest first, the booking id
 * breaking a tie. `bookedAt` alone is not a total order — it is millisecond
 * precision, and the showcase seed gives a whole class one instant — and an
 * unbroken tie would let the queue a member is shown and the queue promotion
 * walks disagree.
 */
export const WAITLIST_ORDER = [
  { bookedAt: 'asc' },
  { id: 'asc' },
] satisfies Prisma.ClassBookingOrderByWithRelationInput[];

/**
 * Locks one ClassSession row until the transaction ends. False when there is
 * no such class.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY PATH THAT CHANGES A SEAT TAKES THIS LOCK FIRST.
 *
 * Booking, cancelling, the desk adding or removing somebody, a capacity edit,
 * a promotion — and marking the register, which changes no seat but shares
 * its rows with the paths that do. Under the lock the session's counters and
 * its bookings cannot move, so every check reads the truth and the write that
 * follows acts on it: no read-then-claim race, no compensating decrement after
 * a lost one, and no surprise unique violation on the booking key. Two members
 * tapping the last seat queue on this row; the second re-reads a full class
 * and is waitlisted, exactly as if they had arrived a second later.
 *
 * `ClassSession_booked_within_capacity` stays as the floor under all of it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Prisma's fluent API cannot express a row lock, so it is one raw statement and
 * the row itself is then read through the typed client, the precedent set by
 * MembershipService.loadForUpdate.
 */
export async function lockClassSession(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<boolean> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "ClassSession" WHERE "id" = ${sessionId}::uuid FOR UPDATE
  `;
  return locked.length > 0;
}
