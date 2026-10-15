import { HttpStatus, Injectable } from '@nestjs/common';
import type { ClassBookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { addDays, gymToday, toDateColumn, type CivilDate } from '../common/time/gym-time';
import {
  MemberNoticesService,
  type MemberNoticeInput,
} from '../notifications/member-notices.service';
import { toClassSession, type ClassSessionDto } from './class.presenter';
import { resolveDateWindow } from '../common/time/date-window';
import type { CreateClassSessionDto, UpdateClassSessionDto } from './dto/class-session.dto';
import { BookingsService } from './bookings.service';
import { SEAT_TX_OPTIONS, SESSION_INCLUDE, lockClassSession } from './class-queries';
import {
  classCancelledNotices,
  classChanged,
  classChangedNotices,
  classPromotedNotices,
} from './class-notices';

/**
 * Every live place in a class: a seat, a place in the queue, or a seat the
 * register has already marked. The register opens 30 minutes before the
 * start, so ATTENDED and NO_SHOW rows exist on a class that has not started
 * yet — and those members are as affected by a change as anybody booked.
 */
const LIVE_PLACES = ['BOOKED', 'WAITLISTED', 'ATTENDED', 'NO_SHOW'] as const;

/**
 * The places that are still a seat once a class has started. A waitlist place
 * on a running class reads "No place" — a change to that class is not news to
 * them.
 */
const SEATS = ['BOOKED', 'ATTENDED', 'NO_SHOW'] as const;

/** A register mark, early or not. */
const MARKED = ['ATTENDED', 'NO_SHOW'] as const;

function classNotFound(): DomainException {
  return new DomainException('CLASS_NOT_FOUND', 'That class does not exist.', HttpStatus.NOT_FOUND);
}

/**
 * A start time the admin typed into the past — 06:00 for 18:00, say. The
 * class it would make could never be edited or cancelled afterwards (both
 * refuse a class that has started), so it is refused before it exists.
 */
function startInThePast(): DomainException {
  return new DomainException(
    'CLASS_ALREADY_STARTED',
    'That start time has already passed. Check the date and the time.',
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/**
 * The timetable.
 *
 * Filtered on `businessDate`, never on `startsAt`. A 06:00 Manila class is
 * 22:00 UTC the previous day, so an instant range would file the busiest
 * session of the morning under yesterday and make "what is on today" wrong for
 * exactly the classes people most want to see.
 *
 * Every session it answers with carries its waitlist length (SESSION_INCLUDE),
 * counted in the same query.
 */
@Injectable()
export class ClassesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly bookings: BookingsService,
    private readonly notices: MemberNoticesService,
  ) {}

  /**
   * A window of the timetable, defaulting to the next fortnight.
   *
   * Cancelled sessions are INCLUDED and flagged rather than hidden. A member
   * who booked a class that was called off must be able to see that it was
   * called off; silently removing it looks like they imagined booking it.
   */
  async list(
    params: { from?: CivilDate; to?: CivilDate; coachId?: string },
    now: Date = new Date(),
  ): Promise<ClassSessionDto[]> {
    const today = gymToday(now, this.gym.timeZone);
    const { from, to } = resolveDateWindow(params, { from: today, to: addDays(today, 14) }, 62);

    const where: Prisma.ClassSessionWhereInput = {
      businessDate: { gte: toDateColumn(from), lte: toDateColumn(to) },
      ...(params.coachId === undefined ? {} : { coachId: params.coachId }),
    };

    const rows = await this.prisma.classSession.findMany({
      where,
      include: SESSION_INCLUDE,
      orderBy: [{ startsAt: 'asc' }],
      take: 200,
    });

    return rows.map(toClassSession);
  }

  async findOne(id: string): Promise<ClassSessionDto> {
    const row = await this.prisma.classSession.findUnique({
      where: { id },
      include: SESSION_INCLUDE,
    });
    if (row === null) throw classNotFound();
    return toClassSession(row);
  }

  /**
   * A new class. Its start must still be ahead: a class created in the past
   * is almost always a mistyped time, and nothing could correct it afterwards
   * — edit and cancel both refuse a class that has started.
   */
  async create(
    createdById: string,
    dto: CreateClassSessionDto,
    now: Date = new Date(),
  ): Promise<ClassSessionDto> {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);

    // Checked here as well as by the CHECK constraint, so the message names
    // the problem instead of surfacing a constraint name.
    if (endsAt <= startsAt) {
      throw new DomainException(
        'CLASS_ENDS_BEFORE_START',
        'The class has to end after it starts.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (startsAt <= now) throw startInThePast();

    await this.assertIsCoach(dto.coachId);

    const row = await this.prisma.classSession.create({
      data: {
        title: dto.title,
        description: dto.description ?? null,
        coachId: dto.coachId,
        startsAt,
        endsAt,
        // Derived from the START, in the gym's zone — never from the server's
        // clock and never from `endsAt`. A class starting 23:30 belongs to the
        // day it starts.
        businessDate: toDateColumn(gymToday(startsAt, this.gym.timeZone)),
        capacity: dto.capacity,
        createdById,
      },
      include: SESSION_INCLUDE,
    });

    return toClassSession(row);
  }

  /**
   * Edit a class, under the same lock every seat change takes.
   *
   * Capacity may be RAISED freely and LOWERED only to the seats already taken.
   * Lowering below `bookedCount` would need somebody to be thrown out, and
   * choosing who is not a decision an edit form should make silently. The
   * error says how many are booked so the answer is obvious.
   *
   * A class that has ENDED is history and cannot be edited; a cancelled one
   * cannot either. Start and end are judged MERGED — a PATCH that moves only
   * the start past the stored end is refused here rather than by the CHECK —
   * and neither may be moved into the past (a class that has not started
   * keeps a start ahead of now; every class keeps an end ahead of now).
   *
   * After the write the waitlist is filled (BookingsService.fillFromWaitlist,
   * under this lock, on this transaction): raising the places from 12 to 14
   * with three people waiting moves the first two eligible ones in, before
   * anybody refreshing the timetable can take the seats ahead of them. The
   * fill runs after EVERY edit — it does nothing unless a seat is free before
   * the waitlist closes — so moving a class later, which can reopen its
   * waitlist, is covered by the same rule.
   *
   * After the commit: CLASS_PROMOTED to whoever moved up, and CLASS_CHANGED
   * when the time, coach or title changed — before the start, to every live
   * place (seated, waiting, or already marked by an early register); once the
   * class is running, to the seats only. The editor themselves is never
   * notified about their own edit.
   */
  async update(
    id: string,
    dto: UpdateClassSessionDto,
    actorId: string,
    now: Date = new Date(),
  ): Promise<ClassSessionDto> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      if (!(await lockClassSession(tx, id))) throw classNotFound();
      const before = await tx.classSession.findUniqueOrThrow({
        where: { id },
        include: SESSION_INCLUDE,
      });

      if (before.cancelledAt !== null) {
        throw new DomainException(
          'CLASS_CANCELLED',
          'That class is cancelled. Create a new one instead.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (before.endsAt <= now) {
        throw new DomainException(
          'CLASS_FINISHED',
          'That class has finished, so it can no longer be changed.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      const startsAt = dto.startsAt === undefined ? undefined : new Date(dto.startsAt);
      const endsAt = dto.endsAt === undefined ? undefined : new Date(dto.endsAt);
      const mergedStart = startsAt ?? before.startsAt;
      const mergedEnd = endsAt ?? before.endsAt;
      if (mergedEnd <= mergedStart) {
        throw new DomainException(
          'CLASS_ENDS_BEFORE_START',
          'The class has to end after it starts.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      // Never INTO the past: a class moved to a start that has passed could
      // no longer be edited or cancelled, and one moved to an end that has
      // passed would be over the moment it was saved. A class already running
      // may still have its end moved later — only a start that has not yet
      // come is held to the first rule.
      if (before.startsAt > now && mergedStart <= now) throw startInThePast();
      if (mergedEnd <= now) {
        throw new DomainException(
          'CLASS_FINISHED',
          'That end time has already passed. Check the date and the time.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (dto.capacity !== undefined && dto.capacity < before.bookedCount) {
        const booked = before.bookedCount;
        throw new DomainException(
          'CAPACITY_BELOW_BOOKED',
          `${booked} ${booked === 1 ? 'person is' : 'people are'} already booked in. Keep at least ${booked} ${booked === 1 ? 'place' : 'places'}, or take someone out of the class first.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (dto.coachId !== undefined) await this.assertIsCoach(dto.coachId, tx);

      await tx.classSession.update({
        where: { id },
        data: {
          ...(dto.title === undefined ? {} : { title: dto.title }),
          ...(dto.description === undefined ? {} : { description: dto.description }),
          ...(dto.coachId === undefined ? {} : { coachId: dto.coachId }),
          ...(dto.capacity === undefined ? {} : { capacity: dto.capacity }),
          ...(endsAt === undefined ? {} : { endsAt }),
          ...(startsAt === undefined
            ? {}
            : {
                startsAt,
                // Moving the start moves the day it belongs to. Leaving
                // businessDate stale would drop the class off "today".
                businessDate: toDateColumn(gymToday(startsAt, this.gym.timeZone)),
              }),
        },
      });

      const promoted = await this.bookings.fillFromWaitlist(tx, id, now);

      // Read last: the answer, and the notices, carry the class as it now is —
      // the promotions included.
      const after = await tx.classSession.findUniqueOrThrow({
        where: { id },
        include: SESSION_INCLUDE,
      });
      // Only an edit somebody's place depends on is news to them. Before the
      // start that is every live place, early register marks included; once
      // the class is running, only the seats — a waitlist place on a running
      // class is no place at all.
      const holders = classChanged(before, after)
        ? await this.holdersOf(tx, id, actorId, now < before.startsAt ? LIVE_PLACES : SEATS)
        : [];
      return { before, after, promoted, holders };
    }, SEAT_TX_OPTIONS);

    const { before, after, promoted, holders } = outcome;
    await this.send([
      ...classPromotedNotices(after, promoted, now, this.gym.timeZone),
      ...classChangedNotices(before, after, holders, now, this.gym.timeZone),
    ]);
    return toClassSession(after);
  }

  /**
   * Cancelling a class, not deleting it.
   *
   * The row stays and every booking stays with it, because members booked into
   * something that was called off need to see that it was called off — and a
   * coach needs to know how many people were affected. A hard delete would
   * make both questions unanswerable. For the same reason `bookedCount` is
   * left alone: on a cancelled class it is the "affected" count.
   *
   * A class that has STARTED cannot be cancelled: it ran, and cancelling it
   * afterwards would lock its register (markAttendance refuses a cancelled
   * class) and tell everybody who came that it never happened.
   *
   * The register opens before the start, so a class that has not started can
   * still carry early marks. They are undone here, on the same transaction:
   * the class never ran, so nobody attended it and nobody missed it.
   *
   * Under the class lock, so no booking can land between the cancel and the
   * list of who to tell. After the commit every member with a live place —
   * seated, waiting, or marked early — gets CLASS_CANCELLED, with the reason
   * as its body.
   */
  async cancel(
    id: string,
    reason: string,
    actorId: string,
    now: Date = new Date(),
  ): Promise<ClassSessionDto> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      if (!(await lockClassSession(tx, id))) throw classNotFound();
      const existing = await tx.classSession.findUniqueOrThrow({
        where: { id },
        select: { cancelledAt: true, startsAt: true },
      });
      if (existing.cancelledAt !== null) {
        throw new DomainException(
          'CLASS_ALREADY_CANCELLED',
          'That class is already cancelled.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (existing.startsAt <= now) {
        throw new DomainException(
          'CLASS_ALREADY_STARTED',
          'That class has already started, so it can no longer be cancelled.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      const row = await tx.classSession.update({
        where: { id },
        data: { cancelledAt: now, cancelReason: reason },
        include: SESSION_INCLUDE,
      });
      // Read before the reset below, though it changes nothing about who is
      // told: every live place, early register marks included.
      const holders = await this.holdersOf(tx, id, actorId, LIVE_PLACES);

      // The register opens 30 minutes early, so a coach may already have
      // marked somebody in a class that is now never going to run. Those marks
      // go back to a plain seat — the member did not attend a class that did
      // not happen, nor miss it. Every column a mark sets is cleared with it
      // (CHECKs ClassBooking_attended_shape, _marked_shape, _marker_shape).
      // Each was a seat already, so `bookedCount` does not move.
      await tx.classBooking.updateMany({
        where: { sessionId: id, status: { in: [...MARKED] } },
        data: { status: 'BOOKED', attendedAt: null, markedAt: null, markedById: null },
      });

      return { row, holders };
    }, SEAT_TX_OPTIONS);

    await this.send(classCancelledNotices(outcome.row, outcome.holders, reason, this.gym.timeZone));
    return toClassSession(outcome.row);
  }

  /**
   * Route 51 — who is expected today.
   *
   * NOW IT HAS AN HONEST ANSWER. Before classes existed this could only have
   * been "every active member" or a guess from attendance history, which is
   * why it was left unbuilt rather than filled with a plausible list.
   */
  async roster(now: Date = new Date()): Promise<ClassSessionDto[]> {
    const today = gymToday(now, this.gym.timeZone);
    return this.list({ from: today, to: today }, now);
  }

  /**
   * A class must be run by somebody who is actually a coach.
   *
   * Checked in the service rather than by a foreign key, because the FK can
   * only say "a user" — role is not expressible in one. `client` lets an edit
   * ask on its own transaction.
   */
  private async assertIsCoach(
    coachId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const coach = await client.user.findUnique({
      where: { id: coachId },
      select: { role: true, deletedAt: true },
    });

    if (coach === null || coach.deletedAt !== null) {
      throw new DomainException(
        'COACH_NOT_FOUND',
        'That coach does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (coach.role !== 'COACH' && coach.role !== 'ADMIN' && coach.role !== 'DEV') {
      throw new DomainException(
        'NOT_A_COACH',
        'That person is not a coach.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  /**
   * Everybody whose place in the class is one of `statuses` — who a change or
   * a cancellation is news to. Never the person making it: somebody who
   * booked as a member and has since joined the staff does not need telling
   * about their own edit.
   */
  private async holdersOf(
    tx: Prisma.TransactionClient,
    sessionId: string,
    actorId: string,
    statuses: readonly ClassBookingStatus[],
  ): Promise<string[]> {
    const rows = await tx.classBooking.findMany({
      where: { sessionId, status: { in: [...statuses] }, userId: { not: actorId } },
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }

  /** After the commit only. Skips the round trip when there is nothing to say. */
  private async send(notices: readonly MemberNoticeInput[]): Promise<void> {
    if (notices.length > 0) await this.notices.notify(notices);
  }
}
