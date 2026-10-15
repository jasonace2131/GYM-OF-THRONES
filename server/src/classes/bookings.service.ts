import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DenialReason,
  bookingRefusalCopy,
  bookingWindowDaysFor,
  registerOpensAt,
  waitlistClosesAt,
  type BookingPlanRequiredDetails,
  type BookingWindowNotOpenDetails,
  type MyBookingWindowWire,
} from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import {
  addDays,
  civilDateFromPrisma,
  gymClockTime,
  gymToday,
  shortDate,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import { resolveDateWindow } from '../common/time/date-window';
import { MembershipService } from '../membership/membership.service';
import { bookingEligibility, type BookingEligibility } from '../membership/booking-eligibility';
import {
  MemberNoticesService,
  type MemberNoticeInput,
} from '../notifications/member-notices.service';
import {
  toClassRegisterEntry,
  toMarkAttendanceResult,
  toMyBooking,
  type ClassRegisterEntry,
  type MarkAttendanceResult,
  type MyBooking,
} from './class.presenter';
import {
  BOOKING_INCLUDE,
  MARKED_SELECT,
  REGISTER_SELECT,
  SEAT_TX_OPTIONS,
  WAITLIST_ORDER,
  lockClassSession,
} from './class-queries';
import {
  bookingAddedNotice,
  bookingRemovedNotice,
  classPromotedNotices,
  gymDayLabel,
  type PromotedPlace,
} from './class-notices';

/** The session columns every seat rule reads, once the row is locked. */
const LOCKED_SESSION_SELECT = {
  id: true,
  title: true,
  startsAt: true,
  endsAt: true,
  businessDate: true,
  capacity: true,
  bookedCount: true,
  cancelledAt: true,
} satisfies Prisma.ClassSessionSelect;

type LockedSession = Prisma.ClassSessionGetPayload<{ select: typeof LOCKED_SESSION_SELECT }>;

/** The statuses a register shows: everyone holding a place, or waiting for one. */
const ON_REGISTER = ['BOOKED', 'WAITLISTED', 'ATTENDED', 'NO_SHOW'] as const;

/**
 * Somebody the booking loader found no live account for reads as having no
 * plan. Only reachable in a race with a soft delete — AuthGuard turns a
 * deleted account away first — and a refusal is the honest answer to it.
 */
const NO_PLAN: BookingEligibility = {
  eligible: false,
  reason: DenialReason.NO_MEMBERSHIP,
  relevantDate: null,
  coversUntil: null,
};

/** A register mark is history, not a reservation. */
function isMarked(status: string): boolean {
  return status === 'ATTENDED' || status === 'NO_SHOW';
}

/**
 * A unique violation on the booking key — the only unique a booking write can
 * hit; every id is generated.
 *
 * Under the session lock two requests of THIS code cannot race for the key:
 * the second queues on the lock and finds the first one's row. A writer that
 * takes no lock can still win it — main's old code during a deploy window —
 * so the violation is mapped, OUTSIDE the transaction: by the time the caller
 * sees it the $transaction call has rejected and rolled back, seat and all,
 * and no statement ever runs on an aborted transaction (the 25P02 rule,
 * prisma-error.mapper.ts).
 */
function isBookingKeyRace(caught: unknown): boolean {
  return caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002';
}

function bookingNotFound(message: string): DomainException {
  return new DomainException('BOOKING_NOT_FOUND', message, HttpStatus.NOT_FOUND);
}

/**
 * Booking a place in a class, and everything that moves one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE TRANSACTION PER CHANGE, AND IT STARTS BY LOCKING THE CLASS.
 *
 * Every path here that changes a seat — a member booking or cancelling, the
 * desk adding or removing somebody, the waitlist moving up — runs in one
 * interactive transaction that first takes `SELECT … FOR UPDATE` on the
 * ClassSession row (`lockClassSession`). Under that lock the seat counter and
 * the class's bookings cannot move, so each rule reads the truth and the write
 * after it acts on the truth. That is what retired the old design's three
 * hazards together: the compensating decrement after a lost claim, a freed
 * seat that a refresh could take ahead of the person waiting for it, and a
 * double-tap surfacing as a raw unique violation.
 *
 * `bookedCount` still only moves by increment and decrement, and
 * `ClassSession_booked_within_capacity` remains the floor under all of it.
 *
 * Notices go out AFTER the commit, never inside: a notice about a seat the
 * transaction then rolled back would tell a member they are in a class they
 * are not in. MemberNoticesService.notify never throws, so a notice that
 * fails costs a line in a bell and never the booking it was about.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The waitlist (owner, 2026-10-11): a freed seat goes to the first person in
 * the queue whose plan covers the class day, or whom the desk added by hand —
 * joined earliest first, the booking id breaking a tie — until 120 minutes
 * before the start. From then on
 * the waitlist is closed: nobody joins it, nobody is promoted, and a freed
 * seat goes to whoever books it first (a member still waiting may take it).
 */
@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly memberships: MembershipService,
    private readonly notices: MemberNoticesService,
  ) {}

  /**
   * The member books a class, joins its waitlist, or takes a freed seat they
   * were waiting for.
   *
   * The rules, in order (owner, 2026-10-11): the class exists, is not
   * cancelled and has not started; the member's plan covers the CLASS DAY
   * (grace and day passes do not count); the day is inside their booking
   * window (14 gym days, today included; 21 on a priority plan). Then:
   *   - already seated or marked: ALREADY_BOOKED;
   *   - waiting, and a seat is free: they take it — how a member still on the
   *     waitlist gets a seat freed after the cutoff, when nobody is promoted.
   *     promotedAt stays null: the member took it, nobody moved them;
   *   - waiting, and still full: ALREADY_BOOKED (still on the waitlist — and,
   *     after the cutoff, that a freed place now goes to whoever books first);
   *   - new, and a seat is free: BOOKED;
   *   - new, full, before the cutoff: WAITLISTED, and the answer says where
   *     in the queue — being waitlisted is a successful outcome, not an error;
   *   - new, full, after the cutoff: WAITLIST_CLOSED.
   *
   * No notice: the member did this themselves, and the answer says what
   * happened.
   */
  async book(userId: string, sessionId: string, now: Date = new Date()): Promise<MyBooking> {
    try {
      return await this.prisma.$transaction(
        (tx) => this.bookInTx(tx, userId, sessionId, now),
        SEAT_TX_OPTIONS,
      );
    } catch (caught) {
      if (isBookingKeyRace(caught)) {
        throw new DomainException(
          'ALREADY_BOOKED',
          'You already have a place in this class.',
          HttpStatus.CONFLICT,
        );
      }
      throw caught;
    }
  }

  private async bookInTx(
    tx: Prisma.TransactionClient,
    userId: string,
    sessionId: string,
    now: Date,
  ): Promise<MyBooking> {
    const session = await this.lockSession(tx, sessionId);
    if (session === null) {
      throw new DomainException(
        'CLASS_NOT_FOUND',
        'That class no longer exists.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (session.cancelledAt !== null) {
      throw new DomainException(
        'CLASS_CANCELLED',
        'That class has been cancelled.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (session.startsAt <= now) {
      // Booking a class that has started is never what somebody meant, and
      // silently allowing it corrupts the register.
      throw new DomainException(
        'CLASS_ALREADY_STARTED',
        'That class has already started.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const today = gymToday(now, this.gym.timeZone);
    const classDay = civilDateFromPrisma(session.businessDate);

    // Read on THIS transaction, so the check runs on the connection that will
    // write the seat. The Membership row is not locked: a seat held by a plan
    // that lapses later is left for the door to decide on the day (owner,
    // 2026-10-11), and so is a lapse that commits inside this gap.
    const subject = await this.memberships.loadBookingSubject(userId, tx);
    const eligibility = subject === null ? NO_PLAN : bookingEligibility(subject, classDay);
    if (!eligibility.eligible) throw planRequired(eligibility, today);

    // How far ahead: counted in gym days on businessDate, never on instants —
    // a 06:00 Manila class is 22:00 UTC the day before. Eligible means the
    // plan covers the class day, so its code is the one to read.
    const windowDays = bookingWindowDaysFor(subject?.planCode);
    if (classDay > addDays(today, windowDays - 1)) {
      const opensOn = addDays(classDay, -(windowDays - 1));
      const details: BookingWindowNotOpenDetails = { opensOn };
      throw new DomainException(
        'BOOKING_WINDOW_NOT_OPEN',
        `Booking for this class opens on ${gymDayLabel(opensOn)}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        details,
      );
    }

    const activeKey = `${sessionId}:${userId}`;
    const seatFree = session.bookedCount < session.capacity;
    const existing = await tx.classBooking.findUnique({
      where: { activeKey },
      select: { id: true, status: true },
    });

    if (existing !== null) {
      // The key is held by every non-cancelled row, including ones the
      // register has marked — so a member marked present cannot book again.
      if (existing.status !== 'WAITLISTED') {
        throw new DomainException(
          'ALREADY_BOOKED',
          isMarked(existing.status)
            ? 'You were already registered for this class.'
            : 'You already have a place in this class.',
          HttpStatus.CONFLICT,
        );
      }
      if (!seatFree) {
        // Usually the 'Take the free place' tap that lost: the seat it saw was
        // booked by somebody else first. After the cutoff the queue no longer
        // moves, so the member must hear that waiting will not bring the next
        // freed place to them by itself.
        throw new DomainException(
          'ALREADY_BOOKED',
          now >= waitlistClosesAt(session.startsAt)
            ? "Someone else took that place first. You're still on the waitlist, but it has closed, so a place now goes to whoever books it first."
            : "This class is full, so you're still on its waitlist.",
          HttpStatus.CONFLICT,
        );
      }
      // Their own row moves into the seat. The seat is counted FIRST, so the
      // booking read back below carries the class's new numbers.
      await this.takeSeats(tx, sessionId, 1);
      const taken = await tx.classBooking.update({
        where: { id: existing.id },
        data: { status: 'BOOKED' },
        include: BOOKING_INCLUDE,
      });
      return toMyBooking(taken, this.gym.timeZone);
    }

    if (seatFree) {
      await this.takeSeats(tx, sessionId, 1);
      const booked = await tx.classBooking.create({
        data: { sessionId, userId, status: 'BOOKED', activeKey, bookedAt: now },
        include: BOOKING_INCLUDE,
      });
      return toMyBooking(booked, this.gym.timeZone);
    }

    const closesAt = waitlistClosesAt(session.startsAt);
    if (now >= closesAt) {
      throw new DomainException(
        'WAITLIST_CLOSED',
        `This class is full, and its waitlist closed at ${gymClockTime(closesAt, this.gym.timeZone)}. If a place frees up, it goes to whoever books it first.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const waiting = await tx.classBooking.create({
      data: { sessionId, userId, status: 'WAITLISTED', activeKey, bookedAt: now },
      include: BOOKING_INCLUDE,
    });
    const places = await this.queuePlaces(tx, [sessionId]);
    return toMyBooking(waiting, this.gym.timeZone, places.get(waiting.id) ?? null);
  }

  /**
   * The member leaves a class or its waitlist. A seat they free goes straight
   * to the first eligible person waiting — the reason a waitlist is worth
   * having — unless the waitlist has closed, in which case it is simply free.
   *
   * Refused once the register has marked them (that is history), once the gym
   * has cancelled the class (there is nothing to leave, and promoting somebody
   * into a cancelled class would tell them they are in a class that is not
   * running — F16), and once it has started (leaving a running class is a
   * no-show).
   *
   * The member's own cancellation records nobody: `cancelledById` names only
   * somebody ELSE taking them out (CHECK ClassBooking_canceller_not_member).
   */
  async cancel(userId: string, sessionId: string, now: Date = new Date()): Promise<MyBooking> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const notHeld = (): DomainException =>
        bookingNotFound('You do not have a place in this class.');

      const session = await this.lockSession(tx, sessionId);
      if (session === null) throw notHeld();

      const booking = await tx.classBooking.findUnique({
        where: { activeKey: `${sessionId}:${userId}` },
        select: { id: true, status: true },
      });
      if (booking === null) throw notHeld();

      if (isMarked(booking.status)) {
        throw new DomainException(
          'BOOKING_NOT_CANCELLABLE',
          'This class has already been marked, so the booking can no longer be cancelled.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (session.cancelledAt !== null) {
        throw new DomainException(
          'CLASS_CANCELLED',
          'The gym has cancelled this class, so there is no booking to cancel.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      // Leaving a class that has started is a no-show dressed as a
      // cancellation, and it would hand a seat nobody can use to the waitlist.
      if (session.startsAt <= now) {
        throw new DomainException(
          'CLASS_ALREADY_STARTED',
          'This class has started, so the booking can no longer be cancelled.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      await tx.classBooking.update({
        where: { id: booking.id },
        data: { status: 'CANCELLED', activeKey: null, cancelledAt: now },
      });

      // Only a BOOKED seat frees one. A waitlisted member leaving changes
      // nothing about capacity, and freeing a seat here would open a phantom.
      const promoted =
        booking.status === 'BOOKED' ? await this.releaseSeat(tx, sessionId, now) : [];

      // Read last, so the answer carries the class's numbers after the
      // promotion as well as before it.
      const row = await tx.classBooking.findUniqueOrThrow({
        where: { id: booking.id },
        include: BOOKING_INCLUDE,
      });
      return { booking: toMyBooking(row, this.gym.timeZone), session, promoted };
    }, SEAT_TX_OPTIONS);

    await this.send(
      classPromotedNotices(outcome.session, outcome.promoted, now, this.gym.timeZone),
    );
    return outcome.booking;
  }

  /**
   * Hands every free seat to the waitlist: the first eligible person first,
   * until the seats or the queue run out. Returns who moved.
   *
   * Runs on its CALLER's transaction, under its caller's lock on the class —
   * a member cancelling, the desk removing somebody, or a capacity edit
   * (ClassesService.update). The counters are re-read here rather than passed
   * in, so a caller can never hand over numbers from before its own write.
   *
   * Does nothing for a class that is cancelled, or once the waitlist has
   * closed (which also covers a class that has started — the cutoff comes
   * first).
   *
   * A waitlister who joined by themselves and whose plan does not cover the
   * class day is SKIPPED and stays WAITLISTED, unnotified (owner default,
   * 2026-10-11): the seat goes to the next eligible person, and if they renew
   * they can still take a free seat themselves. Somebody with no live account
   * is skipped the same way, however they joined.
   *
   * A waitlister the DESK added (`bookedById` set) is promoted in turn, plan
   * or no plan. The desk's add bypasses the plan check by owner rule ("the desk
   * can still add someone by hand"), and that decision has to hold when their
   * turn comes — otherwise a desk add to a full class would be a place in a
   * queue that never moves for them, and the notice telling them "the waitlist
   * moves up by itself" would be false. The door still checks the plan on the
   * day.
   *
   * Each move is a conditional update on the row still being WAITLISTED, and
   * only the moves that land are counted and reported — so even a writer that
   * ignores the lock (old code mid-deploy) can never make the counter and the
   * rows disagree.
   */
  async fillFromWaitlist(
    tx: Prisma.TransactionClient,
    sessionId: string,
    now: Date,
  ): Promise<PromotedPlace[]> {
    const session = await tx.classSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        startsAt: true,
        cancelledAt: true,
        capacity: true,
        bookedCount: true,
        businessDate: true,
      },
    });
    if (session.cancelledAt !== null) return [];
    if (session.startsAt <= now || now >= waitlistClosesAt(session.startsAt)) return [];

    let free = session.capacity - session.bookedCount;
    if (free <= 0) return [];

    const queue = await tx.classBooking.findMany({
      where: { sessionId, status: 'WAITLISTED' },
      orderBy: WAITLIST_ORDER,
      select: { id: true, userId: true, bookedById: true },
    });
    if (queue.length === 0) return [];

    // Everybody queued, loaded in ONE query rather than one per place — the
    // desk's adds too, because a deleted account is skipped whoever added it.
    const subjects = await this.memberships.loadBookingSubjects(
      queue.map((place) => place.userId),
      tx,
    );
    const classDay = civilDateFromPrisma(session.businessDate);

    const promoted: PromotedPlace[] = [];
    for (const place of queue) {
      if (free === 0) break;
      const subject = subjects.get(place.userId);
      if (subject === undefined) continue;
      const addedByDesk = place.bookedById !== null;
      if (!addedByDesk && !bookingEligibility(subject, classDay).eligible) continue;

      const moved = await tx.classBooking.updateMany({
        where: { id: place.id, status: 'WAITLISTED' },
        data: { status: 'BOOKED', promotedAt: now },
      });
      if (moved.count === 0) continue;

      promoted.push({ bookingId: place.id, userId: place.userId });
      free -= 1;
    }

    if (promoted.length > 0) await this.takeSeats(tx, sessionId, promoted.length);
    return promoted;
  }

  /**
   * The desk puts a member into a class by hand (`booking.manage`).
   *
   * Owner, 2026-10-11: no plan check and no booking window — the person at the
   * counter may know what the system does not, and the door still checks the
   * plan on the day. A waitlist place added here keeps that exemption when the
   * queue reaches it (fillFromWaitlist). CAPACITY ALWAYS APPLIES. So, under the
   * lock:
   *   - the account must be a live member (CLIENT): MEMBER_NOT_BOOKABLE;
   *   - a cancelled class is CLASS_CANCELLED, an ended one CLASS_FINISHED — a
   *     class that is RUNNING still takes a walk-in when a seat is free;
   *   - already seated or marked: ALREADY_BOOKED, naming them;
   *   - waiting, and a seat is free: moved in (promotedAt = now — moved by
   *     somebody else, exactly what that column records);
   *   - waiting and full: ALREADY_BOOKED (on the waitlist already);
   *   - new, and a seat is free: BOOKED, recording who added them;
   *   - new, full, before the cutoff: WAITLISTED, recording who added them;
   *   - otherwise WAITLIST_CLOSED: raise the places first.
   *
   * After the commit the member is told (BOOKING_ADDED). Answers with the
   * register row, which is what the screen that asked is showing.
   */
  async addByStaff(
    actorId: string,
    sessionId: string,
    targetUserId: string,
    now: Date = new Date(),
  ): Promise<ClassRegisterEntry> {
    let name = 'This member';
    let outcome: { entry: ClassRegisterEntry; session: LockedSession };
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        const member = await tx.user.findFirst({
          where: { id: targetUserId, deletedAt: null },
          select: { role: true, firstName: true, lastName: true },
        });
        // Staff are not members here (2026-09-25), and an account cannot add
        // itself: a booker who is the member would read as "added by the desk"
        // (CHECK ClassBooking_booker_not_member).
        if (member === null || member.role !== 'CLIENT' || targetUserId === actorId) {
          throw new DomainException(
            'MEMBER_NOT_BOOKABLE',
            'Only a member can be booked into a class. Pick them from the member list.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        name = `${member.firstName} ${member.lastName}`.trim();

        const session = await this.lockSession(tx, sessionId);
        if (session === null) {
          throw new DomainException(
            'CLASS_NOT_FOUND',
            'That class does not exist.',
            HttpStatus.NOT_FOUND,
          );
        }
        if (session.cancelledAt !== null) {
          throw new DomainException(
            'CLASS_CANCELLED',
            'That class has been cancelled.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        if (session.endsAt <= now) {
          throw new DomainException(
            'CLASS_FINISHED',
            'That class has finished, so nobody can be added to it.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        const activeKey = `${sessionId}:${targetUserId}`;
        const seatFree = session.bookedCount < session.capacity;
        const existing = await tx.classBooking.findUnique({
          where: { activeKey },
          select: { id: true, status: true },
        });

        let bookingId: string;
        if (existing !== null) {
          if (existing.status !== 'WAITLISTED') {
            throw new DomainException(
              'ALREADY_BOOKED',
              isMarked(existing.status)
                ? `${name} was already registered for this class.`
                : `${name} already has a place in this class.`,
              HttpStatus.CONFLICT,
            );
          }
          if (!seatFree) {
            throw new DomainException(
              'ALREADY_BOOKED',
              `${name} is already on the waitlist for this class.`,
              HttpStatus.CONFLICT,
            );
          }
          await this.takeSeats(tx, sessionId, 1);
          await tx.classBooking.update({
            where: { id: existing.id },
            data: { status: 'BOOKED', promotedAt: now },
          });
          bookingId = existing.id;
        } else if (seatFree) {
          await this.takeSeats(tx, sessionId, 1);
          const created = await tx.classBooking.create({
            data: {
              sessionId,
              userId: targetUserId,
              status: 'BOOKED',
              activeKey,
              bookedAt: now,
              bookedById: actorId,
            },
            select: { id: true },
          });
          bookingId = created.id;
        } else if (now < waitlistClosesAt(session.startsAt)) {
          // The cutoff falls before the start, so a running class never
          // takes a waitlist place: a full class that has started is below.
          const created = await tx.classBooking.create({
            data: {
              sessionId,
              userId: targetUserId,
              status: 'WAITLISTED',
              activeKey,
              bookedAt: now,
              bookedById: actorId,
            },
            select: { id: true },
          });
          bookingId = created.id;
        } else {
          throw new DomainException(
            'WAITLIST_CLOSED',
            `This class is full and its waitlist has closed. Raise the places to add ${name}.`,
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        return { entry: await this.registerEntry(tx, sessionId, bookingId), session };
      }, SEAT_TX_OPTIONS);
    } catch (caught) {
      if (isBookingKeyRace(caught)) {
        throw new DomainException(
          'ALREADY_BOOKED',
          `${name} already has a place in this class.`,
          HttpStatus.CONFLICT,
        );
      }
      throw caught;
    }

    const { entry, session } = outcome;
    await this.send([
      bookingAddedNotice(
        session,
        {
          bookingId: entry.bookingId,
          userId: targetUserId,
          status: entry.status === 'WAITLISTED' ? 'WAITLISTED' : 'BOOKED',
          waitlistPosition: entry.waitlistPosition,
        },
        now,
        this.gym.timeZone,
      ),
    ]);
    return entry;
  }

  /**
   * The desk takes a member out of a class (`booking.manage`), with a reason
   * the member is shown.
   *
   * Refused for a booking already cancelled, one the register has marked, a
   * class the gym cancelled, and a class that has started — "mark them as a
   * no-show instead", which is what the register is for. A freed seat goes to
   * the waitlist exactly as a member's own cancellation's does.
   *
   * Records who removed them and why (`cancelledById`, `removalReason`), which
   * is how the member's history tells a removal from their own cancel. After
   * the commit: BOOKING_REMOVED to the member, CLASS_PROMOTED to whoever moved
   * up. Answers with the removed row as the register would show it.
   *
   * One edge, handled rather than refused: an account removing its OWN booking
   * (somebody who booked as a member and has since joined the staff). That is
   * the member's own cancellation, and is recorded as one — the actor columns
   * name only somebody else (CHECK ClassBooking_canceller_not_member).
   */
  async removeByStaff(
    actorId: string,
    bookingId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<ClassRegisterEntry> {
    const removalReason = reason.trim();

    const outcome = await this.prisma.$transaction(async (tx) => {
      const missing = (): DomainException => bookingNotFound('That booking does not exist.');

      // The session is the lock, so find it first; a booking never changes
      // class, so this read cannot go stale.
      const ref = await tx.classBooking.findUnique({
        where: { id: bookingId },
        select: { sessionId: true },
      });
      if (ref === null) throw missing();
      const session = await this.lockSession(tx, ref.sessionId);
      if (session === null) throw missing();

      const booking = await tx.classBooking.findUnique({
        where: { id: bookingId },
        select: { id: true, userId: true, status: true },
      });
      if (booking === null) throw missing();

      if (booking.status === 'CANCELLED') {
        throw new DomainException(
          'BOOKING_CANCELLED',
          'That booking has already been cancelled.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (isMarked(booking.status)) {
        throw new DomainException(
          'BOOKING_NOT_CANCELLABLE',
          'The register has already marked this booking, so it can no longer be removed.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (session.cancelledAt !== null) {
        throw new DomainException(
          'CLASS_CANCELLED',
          'The gym has cancelled this class, so there is nobody to remove.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (session.startsAt <= now) {
        throw new DomainException(
          'CLASS_ALREADY_STARTED',
          'This class has started, so the booking can no longer be removed. Mark them as a no-show instead.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      const byStaff = booking.userId !== actorId;
      const data: Prisma.ClassBookingUncheckedUpdateInput = {
        status: 'CANCELLED',
        activeKey: null,
        cancelledAt: now,
        ...(byStaff ? { cancelledById: actorId, removalReason } : {}),
      };
      await tx.classBooking.update({ where: { id: booking.id }, data });

      const promoted =
        booking.status === 'BOOKED' ? await this.releaseSeat(tx, session.id, now) : [];

      return {
        entry: await this.registerEntry(tx, session.id, booking.id),
        session,
        memberId: booking.userId,
        byStaff,
        promoted,
      };
    }, SEAT_TX_OPTIONS);

    const { entry, session, memberId, byStaff, promoted } = outcome;
    await this.send([
      ...(byStaff
        ? [
            bookingRemovedNotice(
              session,
              { bookingId: entry.bookingId, userId: memberId },
              removalReason,
              this.gym.timeZone,
            ),
          ]
        : []),
      ...classPromotedNotices(session, promoted, now, this.gym.timeZone),
    ]);
    return entry;
  }

  /**
   * The member's own bookings in a window of gym days, soonest first.
   *
   * Every status, because a member's history includes the classes they missed
   * and the ones they cancelled. The window replaces a `take: 50` over an
   * ascending list, which returned a long-standing member's OLDEST fifty rows
   * and silently dropped everything they had booked for next week.
   *
   * A waitlisted booking carries its place in the queue until the waitlist
   * closes, and none after: from then on nobody is promoted, and a number
   * would promise a seat the queue can no longer give. All the places come
   * from ONE extra query, however many classes the member is waiting for.
   */
  async mine(
    userId: string,
    params: { from?: string; to?: string } = {},
    now: Date = new Date(),
  ): Promise<MyBooking[]> {
    const today = gymToday(now, this.gym.timeZone);
    const { from, to } = resolveDateWindow(
      params,
      { from: addDays(today, -60), to: addDays(today, 60) },
      180,
    );

    const rows = await this.prisma.classBooking.findMany({
      where: {
        userId,
        session: { businessDate: { gte: toDateColumn(from), lte: toDateColumn(to) } },
      },
      include: BOOKING_INCLUDE,
      orderBy: { session: { startsAt: 'asc' } },
      // A backstop, not a page size: 180 days of one member's classes.
      take: 500,
    });

    const queued = rows.filter(
      (row) => row.status === 'WAITLISTED' && now < waitlistClosesAt(row.session.startsAt),
    );
    const places = await this.queuePlaces(
      this.prisma,
      queued.map((row) => row.sessionId),
    );

    return rows.map((row) => toMyBooking(row, this.gym.timeZone, places.get(row.id) ?? null));
  }

  /**
   * Who is in a class. `booking.read` — staff only; a member sees only their own.
   *
   * Seated and marked rows first, in the order they booked, then the waitlist
   * in queue order with each place numbered. Ordered here, explicitly: sorting
   * on the status column follows the ENUM's declaration order (BOOKED,
   * WAITLISTED, CANCELLED, ATTENDED, NO_SHOW), which dropped every member the
   * coach had just marked present below the people still waiting.
   *
   * An unknown class is a 404 rather than an empty register, so a stale link
   * says the class is gone instead of claiming nobody came.
   */
  async register(sessionId: string): Promise<ClassRegisterEntry[]> {
    const session = await this.prisma.classSession.findUnique({
      where: { id: sessionId },
      select: {
        bookings: {
          where: { status: { in: [...ON_REGISTER] } },
          select: REGISTER_SELECT,
          orderBy: WAITLIST_ORDER,
        },
      },
    });
    if (session === null) {
      throw new DomainException(
        'CLASS_NOT_FOUND',
        'That class does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }

    const seated = session.bookings.filter((row) => row.status !== 'WAITLISTED');
    const waiting = session.bookings.filter((row) => row.status === 'WAITLISTED');
    return [
      ...seated.map((row) => toClassRegisterEntry(row)),
      ...waiting.map((row, index) => toClassRegisterEntry(row, index + 1)),
    ];
  }

  /**
   * Marking the register (`booking.attend`), recording who marked it and when
   * — on BOTH outcomes, which `attendedAt` alone never could: a no-show has
   * no attendance time.
   *
   * The rules are unchanged: nothing to mark on a cancelled booking or a
   * cancelled class, a waitlisted member has no seat to mark, and the register
   * opens 30 minutes before the start. There is still no upper limit — a
   * missed register can be fixed days later (owner default, 2026-10-11) — and
   * a correction overwrites the marker: the last one wins.
   *
   * It takes the class lock too. Marking changes no seat, but it shares rows
   * with the paths that do: unlocked, a mark landing between a removal's check
   * and its write would leave a cancelled row carrying a marker.
   */
  async markAttendance(
    actorId: string,
    bookingId: string,
    attended: boolean,
    now: Date = new Date(),
  ): Promise<MarkAttendanceResult> {
    return this.prisma.$transaction(async (tx) => {
      const missing = (): DomainException => bookingNotFound('That booking does not exist.');

      const ref = await tx.classBooking.findUnique({
        where: { id: bookingId },
        select: { sessionId: true },
      });
      if (ref === null) throw missing();
      const session = await this.lockSession(tx, ref.sessionId);
      if (session === null) throw missing();

      const booking = await tx.classBooking.findUnique({
        where: { id: bookingId },
        select: { status: true },
      });
      if (booking === null) throw missing();

      // A cancelled booking is not a no-show — the member told us. Marking one
      // would turn a courtesy into a black mark.
      if (booking.status === 'CANCELLED') {
        throw new DomainException(
          'BOOKING_CANCELLED',
          'That booking was cancelled, so there is nothing to mark.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (session.cancelledAt !== null) {
        throw new DomainException(
          'CLASS_CANCELLED',
          'That class was cancelled, so there is no register to mark.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (booking.status === 'WAITLISTED') {
        throw new DomainException(
          'BOOKING_NOT_CONFIRMED',
          'Only confirmed places can be marked. This member is still on the waitlist.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      // Marking a class days ahead is how a member once held two seats in one
      // class. The register opens shortly before start, and not earlier.
      const opensAt = registerOpensAt(session.startsAt);
      if (now < opensAt) {
        throw new DomainException(
          'CLASS_NOT_STARTED',
          `The register opens at ${gymClockTime(opensAt, this.gym.timeZone)}.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      // activeKey is deliberately NOT cleared: it is what stops a member who
      // has been marked from booking the same class a second time.
      const data: Prisma.ClassBookingUncheckedUpdateInput = attended
        ? { status: 'ATTENDED', attendedAt: now, markedAt: now, markedById: actorId }
        : { status: 'NO_SHOW', attendedAt: null, markedAt: now, markedById: actorId };

      const row = await tx.classBooking.update({
        where: { id: bookingId },
        data,
        select: MARKED_SELECT,
      });
      return toMarkAttendanceResult(row);
    }, SEAT_TX_OPTIONS);
  }

  /**
   * `GET /me/booking-window` — how far ahead the member may book, and whether
   * their plan lets them book at all, judged on TODAY.
   *
   * The timetable sizes its strip from this and explains a refusal before the
   * member taps Book; every booking is still checked again on its own day.
   *
   * The priority window is a perk of a plan that still covers a day: a plan
   * that has ended (or, frozen with no record of when it thaws, covers none)
   * gets the standard fourteen, so an expired Annual member is not shown three
   * weeks of days they cannot book. `planCoversUntil` is likewise null once it
   * lies behind today — a date in the past is not a day the plan covers, and
   * "classes after 5 Oct need a renewal" on 11 Oct would read as nonsense.
   */
  async bookingWindow(userId: string, now: Date = new Date()): Promise<MyBookingWindowWire> {
    const today = gymToday(now, this.gym.timeZone);
    const subject = await this.memberships.loadBookingSubject(userId);
    const eligibility = subject === null ? NO_PLAN : bookingEligibility(subject, today);

    const coversUntil =
      eligibility.coversUntil !== null && eligibility.coversUntil >= today
        ? eligibility.coversUntil
        : null;
    const windowDays = bookingWindowDaysFor(coversUntil === null ? null : subject?.planCode);
    const reason = eligibility.reason;

    return {
      windowDays,
      lastBookableDay: addDays(today, windowDays - 1),
      eligibleToday: eligibility.eligible,
      reason,
      message: reason === null ? null : bookingRefusalCopy(reason, namedDay(eligibility, today)),
      planCoversUntil: coversUntil,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Locks the class (`lockClassSession`), then reads it. Null when it does not exist. */
  private async lockSession(
    tx: Prisma.TransactionClient,
    sessionId: string,
  ): Promise<LockedSession | null> {
    if (!(await lockClassSession(tx, sessionId))) return null;
    return tx.classSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: LOCKED_SESSION_SELECT,
    });
  }

  /**
   * Counts `n` seats as taken. A plain increment: the caller holds the lock
   * and has just read a free seat for each, and the CHECK is the floor.
   */
  private async takeSeats(
    tx: Prisma.TransactionClient,
    sessionId: string,
    n: number,
  ): Promise<void> {
    await tx.classSession.update({
      where: { id: sessionId },
      data: { bookedCount: { increment: n } },
    });
  }

  /**
   * A BOOKED place was given up: the seat comes off the counter and goes
   * straight to the waitlist. Under the lock the two steps are one move —
   * nobody can book in between — so the seat is never up for grabs while
   * somebody eligible is waiting for it.
   *
   * The decrement is guarded on a positive counter, so a counter that ever
   * drifted low can never be pushed below zero by this.
   */
  private async releaseSeat(
    tx: Prisma.TransactionClient,
    sessionId: string,
    now: Date,
  ): Promise<PromotedPlace[]> {
    await tx.classSession.updateMany({
      where: { id: sessionId, bookedCount: { gt: 0 } },
      data: { bookedCount: { decrement: 1 } },
    });
    return this.fillFromWaitlist(tx, sessionId, now);
  }

  /**
   * 1-based queue places for every WAITLISTED booking in these classes, keyed
   * by booking id, in the order the waitlist is served. One query, whatever
   * the number of classes.
   */
  private async queuePlaces(
    client: Prisma.TransactionClient,
    sessionIds: readonly string[],
  ): Promise<Map<string, number>> {
    const ids = [...new Set(sessionIds)];
    if (ids.length === 0) return new Map();

    const queue = await client.classBooking.findMany({
      where: { sessionId: { in: ids }, status: 'WAITLISTED' },
      orderBy: WAITLIST_ORDER,
      select: { id: true, sessionId: true },
    });

    const counted = new Map<string, number>();
    const places = new Map<string, number>();
    for (const row of queue) {
      const place = (counted.get(row.sessionId) ?? 0) + 1;
      counted.set(row.sessionId, place);
      places.set(row.id, place);
    }
    return places;
  }

  /** One booking as the register shows it, read on the transaction that wrote it. */
  private async registerEntry(
    tx: Prisma.TransactionClient,
    sessionId: string,
    bookingId: string,
  ): Promise<ClassRegisterEntry> {
    const row = await tx.classBooking.findUniqueOrThrow({
      where: { id: bookingId },
      select: REGISTER_SELECT,
    });
    const place =
      row.status === 'WAITLISTED'
        ? ((await this.queuePlaces(tx, [sessionId])).get(row.id) ?? null)
        : null;
    return toClassRegisterEntry(row, place);
  }

  /** After the commit only. Skips the round trip when there is nothing to say. */
  private async send(notices: readonly MemberNoticeInput[]): Promise<void> {
    if (notices.length > 0) await this.notices.notify(notices);
  }
}

/**
 * BOOKING_PLAN_REQUIRED, in the member's words (`bookingRefusalCopy`).
 *
 * The day the refusal is about is named only while it is today or later:
 * "your plan ends 5 Oct, before this class" is wrong on 11 Oct, when the plan
 * has simply ended. `details.relevantDate` is the day the message names, or
 * null when it names none — so a screen acting on it never contradicts the
 * sentence beside it.
 */
function planRequired(eligibility: BookingEligibility, today: CivilDate): DomainException {
  const reason = eligibility.reason ?? DenialReason.NO_MEMBERSHIP;
  const named = namedDay(eligibility, today);
  const details: BookingPlanRequiredDetails = {
    reason,
    relevantDate: named === null ? null : eligibility.relevantDate,
  };
  return new DomainException(
    'BOOKING_PLAN_REQUIRED',
    bookingRefusalCopy(reason, named),
    HttpStatus.UNPROCESSABLE_ENTITY,
    details,
  );
}

/** The refusal's day as the copy names it ('16 Aug'), or null when it is behind today. */
function namedDay(eligibility: BookingEligibility, today: CivilDate): string | null {
  const day = eligibility.relevantDate;
  return day !== null && day >= today ? shortDate(day) : null;
}
