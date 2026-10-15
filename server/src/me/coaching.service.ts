import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import {
  addDays,
  civilDateFromPrisma,
  gymToday,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import type { CoachMemberRow, CoachSession, CoachSummary } from './coaching.presenter';

/**
 * A booking that has been marked one way or the other. Anything still at
 * BOOKED or WAITLISTED has not happened yet and belongs in no rate.
 */
const MARKED = ['ATTENDED', 'NO_SHOW'] as const;

/**
 * Every SEAT on the register, marked or not. Not WAITLISTED: a waitlist place
 * is not a seat and can never be marked (markAttendance refuses it), so
 * counting it made "12 of 18 marked" a register that could never be finished.
 */
const SEATED = ['BOOKED', 'ATTENDED', 'NO_SHOW'] as const;

/**
 * How far back "recently" reaches for the visit counter on the member list.
 * Thirty days rather than "this month": a count that resets on the 1st tells a
 * coach nothing on the 2nd.
 */
const RECENT_DAYS = 30;

/** A page of members is a caseload, not a mailing list. */
const MEMBER_LIMIT = 200;

/** A fortnight of classes at four a day still fits comfortably. */
const SESSION_LIMIT = 200;

/**
 * The coach's own dashboard.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE COACH IS ALWAYS `request.user.id`. THERE IS NO `coachId` PARAMETER.
 *
 * Every method here takes `coachId` from its caller, and its only caller is a
 * controller that reads it off the verified token. That is what makes these
 * routes safe without a scope filter: there is no input that could name
 * somebody else, so there is nothing for `ScopedWhere` to constrain.
 *
 * If an admin-facing "view any coach's dashboard" screen is ever wanted, it
 * does NOT get built by adding a `coachId` query parameter to these routes —
 * it gets its own `coach.read`-at-ALL route, so the two audiences cannot be
 * confused by a parameter that is optional in one direction only.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class CoachingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
  ) {}

  /**
   * The gym-local week containing `day`, Monday to Sunday.
   *
   * Read off a `@db.Date`-shaped value at UTC midnight, so `getUTCDay()` is
   * the civil weekday and there is no zone to get wrong. Monday-start because
   * that is how a gym publishes a timetable, not because of any locale.
   */
  private weekOf(day: CivilDate): { from: CivilDate; to: CivilDate } {
    const backToMonday = (toDateColumn(day).getUTCDay() + 6) % 7;
    const from = addDays(day, -backToMonday);
    return { from, to: addDays(from, 6) };
  }

  async summary(coachId: string, now: Date = new Date()): Promise<CoachSummary> {
    const today = gymToday(now, this.gym.timeZone);
    const week = this.weekOf(today);

    const todaysSessions = {
      coachId,
      cancelledAt: null,
      businessDate: toDateColumn(today),
    };

    const [assignedMembers, sessionsThisWeek, sessionsToday, bookedToday, markedToday] =
      await this.prisma.$transaction([
        this.prisma.coachAssignment.count({ where: { coachId, status: 'ACTIVE' } }),
        this.prisma.classSession.count({
          where: {
            coachId,
            cancelledAt: null,
            businessDate: { gte: toDateColumn(week.from), lte: toDateColumn(week.to) },
          },
        }),
        this.prisma.classSession.count({ where: todaysSessions }),
        this.prisma.classBooking.count({
          where: { session: todaysSessions, status: { in: [...SEATED] } },
        }),
        this.prisma.classBooking.count({
          where: { session: todaysSessions, status: { in: [...MARKED] } },
        }),
      ]);

    return {
      assignedMembers,
      sessionsThisWeek,
      sessionsToday,
      bookedToday,
      markedToday,
      weekFrom: week.from,
      weekTo: week.to,
    };
  }

  /**
   * My sessions in a window, defaulting to this week.
   *
   * Cancelled sessions are INCLUDED and flagged, exactly as the member-facing
   * timetable does it — a coach whose Thursday class was called off needs to
   * see that it was called off, not to find a hole in their week.
   */
  async schedule(
    coachId: string,
    params: { from?: CivilDate; to?: CivilDate },
    now: Date = new Date(),
  ): Promise<CoachSession[]> {
    const today = gymToday(now, this.gym.timeZone);
    const week = this.weekOf(today);
    const from = params.from ?? week.from;
    const to = params.to ?? week.to;

    const rows = await this.prisma.classSession.findMany({
      where: {
        coachId,
        businessDate: { gte: toDateColumn(from), lte: toDateColumn(to) },
      },
      orderBy: { startsAt: 'asc' },
      take: SESSION_LIMIT,
      select: {
        id: true,
        title: true,
        startsAt: true,
        endsAt: true,
        businessDate: true,
        capacity: true,
        bookedCount: true,
        cancelledAt: true,
        cancelReason: true,
        // The register's marked seats, per session, in the same round trip. A
        // count per session would be N+1 queries for a screen that renders at
        // most a fortnight of them.
        bookings: {
          where: { status: { in: [...MARKED] } },
          select: { status: true },
        },
      },
    });

    return rows.map((row) => {
      const attended = row.bookings.filter((booking) => booking.status === 'ATTENDED').length;
      const noShow = row.bookings.length - attended;

      return {
        id: row.id,
        title: row.title,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        businessDate: civilDateFromPrisma(row.businessDate),
        capacity: row.capacity,
        bookedCount: row.bookedCount,
        seatsLeft: Math.max(0, row.capacity - row.bookedCount),
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
        cancelReason: row.cancelReason,
        attended,
        noShow,
        marked: row.bookings.length,
      };
    });
  }

  /**
   * My caseload — the members assigned to me right now, with the two facts a
   * coach actually asks about: are they coming in, and do they turn up to what
   * they book.
   *
   * Soft-deleted members are dropped rather than rendered as a blank row (§4.4
   * of the RBAC design: a deleted user is invisible to every member-facing
   * read). An ACTIVE assignment to a deleted account is possible — the delete
   * is a soft one and does not cascade — so this filter is load-bearing rather
   * than defensive.
   */
  async members(coachId: string, now: Date = new Date()): Promise<CoachMemberRow[]> {
    const assignments = await this.prisma.coachAssignment.findMany({
      where: { coachId, status: 'ACTIVE', member: { deletedAt: null } },
      orderBy: { startedAt: 'desc' },
      take: MEMBER_LIMIT,
      select: {
        startedAt: true,
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            memberCode: true,
            avatarUrl: true,
          },
        },
      },
    });

    if (assignments.length === 0) return [];

    const ids = assignments.map((row) => row.member.id);
    const today = gymToday(now, this.gym.timeZone);
    const since = toDateColumn(addDays(today, -(RECENT_DAYS - 1)));

    // `Promise.all`, deliberately, rather than the array form of
    // `$transaction`. These are five independent read-only aggregates and a
    // shared snapshot buys a dashboard nothing — while the array form widens
    // every `groupBy` result to a union that loses `_count` and `_max`, which
    // would mean casting the precision back in by hand at each call site.
    const [recentVisits, lastVisits, openVisits, marked, attended] = await Promise.all([
      // Visits in the window. Voided rows are excluded from all four counters
      // below: a void is the desk saying the visit did not happen, and
      // counting one would tell a coach their member came in on a day staff
      // already corrected away.
      this.prisma.checkIn.groupBy({
        by: ['userId'],
        where: { userId: { in: ids }, voidedAt: null, businessDate: { gte: since } },
        orderBy: { userId: 'asc' },
        _count: { _all: true },
      }),
      this.prisma.checkIn.groupBy({
        by: ['userId'],
        where: { userId: { in: ids }, voidedAt: null },
        orderBy: { userId: 'asc' },
        _max: { occurredAt: true },
      }),
      // Inside right now. `endedAt: null` is the open-visit test the door
      // itself uses, and `openUserId` is the unique sentinel behind it.
      this.prisma.checkIn.findMany({
        where: { userId: { in: ids }, voidedAt: null, endedAt: null },
        select: { userId: true },
      }),
      this.prisma.classBooking.groupBy({
        by: ['userId'],
        where: { userId: { in: ids }, status: { in: [...MARKED] } },
        orderBy: { userId: 'asc' },
        _count: { _all: true },
      }),
      this.prisma.classBooking.groupBy({
        by: ['userId'],
        where: { userId: { in: ids }, status: 'ATTENDED' },
        orderBy: { userId: 'asc' },
        _count: { _all: true },
      }),
    ]);

    // `CheckIn.userId` is nullable — an account-less walk-in guest has none —
    // so these maps are keyed on `string | null`. Every `in: ids` filter above
    // already excludes the null rows; the key type is just what Prisma reports.
    const recentBy = new Map(recentVisits.map((row) => [row.userId, row._count._all]));
    const lastBy = new Map(lastVisits.map((row) => [row.userId, row._max.occurredAt]));
    const openBy = new Set(openVisits.map((row) => row.userId));
    const markedBy = new Map(marked.map((row) => [row.userId, row._count._all]));
    const attendedBy = new Map(attended.map((row) => [row.userId, row._count._all]));

    return assignments.map((row) => {
      const member = row.member;
      const classesMarked = markedBy.get(member.id) ?? 0;
      const classesAttended = attendedBy.get(member.id) ?? 0;

      return {
        userId: member.id,
        firstName: member.firstName,
        lastName: member.lastName,
        memberCode: member.memberCode,
        avatarUrl: member.avatarUrl,
        since: row.startedAt.toISOString(),
        lastVisitAt: lastBy.get(member.id)?.toISOString() ?? null,
        visits30d: recentBy.get(member.id) ?? 0,
        inGymNow: openBy.has(member.id),
        classesAttended,
        classesMarked,
        // NULL, never 0, when nothing has been marked — see the presenter.
        attendanceRate:
          classesMarked === 0 ? null : Math.round((classesAttended / classesMarked) * 100),
      };
    });
  }
}
