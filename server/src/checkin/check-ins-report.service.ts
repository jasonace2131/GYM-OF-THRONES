import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PermissionScope } from '@prisma/client';
import {
  REPORT_MAX_RANGE_DAYS,
  type CheckInRecord,
  type CheckInSummary,
  type DeskDenial,
  type PaginatedData,
} from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import { DomainException } from '../common/exceptions/domain.exception';
import { civilDaysBetween, gymToday, toDateColumn, type CivilDate } from '../common/time/gym-time';
import { coachedMemberWhere } from '../rbac/scope.util';
import { MembershipService } from '../membership/membership.service';
import { accessVerdict } from '../membership/access-verdict';
import { deskMemberFrom, toCheckInRecord, toDeskDenial } from '../front-desk/desk.presenter';
import type { ListCheckInsQueryDto } from './dto/list-check-ins-query.dto';
import type { ListDenialsQueryDto } from './dto/list-denials-query.dto';

/**
 * Attendance reporting — routes 53, 54 and 55.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * REUSES `CheckInRecord` AND `DeskDenial` RATHER THAN THE SPEC'S
 * `CheckInListItem` / `CheckInDetail` / `DenialListItem`.
 *
 * Those three names were reserved in the route table and never defined
 * anywhere — no shape, no fields. Meanwhile the desk console already projects
 * exactly this data through `toCheckInRecord` and `toDeskDenial`, and both go
 * through `DeskMember`, the privacy boundary. Minting a second projection of
 * the same rows would mean two presenters that can disagree about what a
 * visit looks like, and only one of them carrying the boundary.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * FILTERED ON `businessDate`, NEVER ON `occurredAt`. The gym opens at 05:00
 * Manila — 21:00 UTC the previous day — so an instant range would file the
 * busiest hour of every morning under the wrong date and quietly disagree
 * with the daily figures on the dashboard.
 */
const MEMBER_INCLUDE = {
  select: {
    id: true,
    firstName: true,
    lastName: true,
    memberCode: true,
    avatarUrl: true,
    status: true,
    membership: {
      include: { holds: { where: { activeMembershipId: { not: null } }, take: 1 } },
    },
  },
} as const;

/**
 * Whose visits the caller may read: `checkin.read` at ALL is everyone; at OWN
 * (a coach, by default) it is the members assigned to them — the same
 * `coachedMember` reach every other coach read uses. Before 2026-11-09 these
 * routes ignored the scope, so a coach could read every member's visits.
 */
export interface CheckInReach {
  scope: PermissionScope;
  callerId: string;
}

/** The query fields that narrow which visits count; paging is separate. */
export type CheckInFilters = Omit<ListCheckInsQueryDto, 'page' | 'limit'>;

@Injectable()
export class CheckInsReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly memberships: MembershipService,
  ) {}

  private get verdictConfig(): { expiringSoonDays: number; graceAdmissionsMax: number } {
    return {
      expiringSoonDays: this.gym.expiringSoonDays,
      graceAdmissionsMax: this.gym.graceAdmissionsMax,
    };
  }

  /** Route 53. */
  async list(
    query: ListCheckInsQueryDto,
    reach: CheckInReach,
    now: Date = new Date(),
  ): Promise<PaginatedData<CheckInRecord>> {
    const today = gymToday(now, this.gym.timeZone);
    const where = this.where(query, reach);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.checkIn.findMany({
        where,
        include: { user: MEMBER_INCLUDE, station: { select: { code: true, name: true } } },
        // `id` as a tiebreak: two arrivals inside the same millisecond would
        // otherwise page non-deterministically and could drop or repeat a row.
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        ...paginationSkipTake(query),
      }),
      this.prisma.checkIn.count({ where }),
    ]);

    return paginated(
      rows.map((row) => toCheckInRecord(row, today, this.verdictConfig)),
      total,
      query,
    );
  }

  /**
   * Route 54.
   *
   * Includes voided visits: this is the route a dispute lands on, and the
   * corrected row with its reason is the whole answer. A 404 for something
   * that exists but was voided would read as "we have no record", which is
   * exactly the wrong thing to tell somebody querying a charge.
   */
  async findOne(id: string, reach: CheckInReach, now: Date = new Date()): Promise<CheckInRecord> {
    // findFirst, not findUnique: the reach is a relation filter. A visit out of
    // reach is a 404, the same as one that does not exist, so the route is no
    // oracle for which ids are real.
    const row = await this.prisma.checkIn.findFirst({
      where: { id, ...this.reachWhere(reach) },
      include: { user: MEMBER_INCLUDE, station: { select: { code: true, name: true } } },
    });

    if (row === null) throw new NotFoundException('Check-in not found');
    return toCheckInRecord(row, gymToday(now, this.gym.timeZone), this.verdictConfig);
  }

  /** Route 55 — the number that says whether the door is set right. */
  async listDenials(
    query: ListDenialsQueryDto,
    reach: CheckInReach,
    now: Date = new Date(),
  ): Promise<PaginatedData<DeskDenial>> {
    const today = gymToday(now, this.gym.timeZone);
    const where: Prisma.CheckInDenialWhereInput = {
      ...(reach.scope === 'ALL' ? {} : { user: coachedMemberWhere(reach.callerId) }),
      ...this.dateRange(query.from, query.to),
      ...(query.userId === undefined ? {} : { userId: query.userId }),
      ...(query.stationId === undefined ? {} : { stationId: query.stationId }),
      ...(query.reason === undefined ? {} : { reason: query.reason }),
      ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.checkInDenial.findMany({
        where,
        include: { user: MEMBER_INCLUDE, station: { select: { code: true, name: true } } },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        ...paginationSkipTake(query),
      }),
      this.prisma.checkInDenial.count({ where }),
    ]);

    // `CheckInDenial.userId` is NOT NULL — a denial is always about somebody
    // with an account, because an off-the-street guest cannot be turned away
    // by a door that never knew them. So no guest branch here, unlike the
    // check-in projection above.
    const items = await Promise.all(
      rows.map(async (row) =>
        toDeskDenial(
          { ...row, station: row.station },
          deskMemberFrom(row.user as never, today, this.verdictConfig),
          await this.messageFor(row.userId, today),
        ),
      ),
    );

    return paginated(items, total, query);
  }

  /**
   * The staff-facing sentence for a historical denial.
   *
   * Recomputed from the member's CURRENT standing rather than stored, which is
   * deliberate and worth stating: a denial from three weeks ago whose member
   * has since renewed should not still read "membership expired" on a report
   * somebody is using to decide whether to call them. The reason column is the
   * historical fact; this line is the current one.
   */
  private async messageFor(userId: string, today: CivilDate): Promise<string> {
    const subject = await this.memberships.loadSubject(userId, today);
    return accessVerdict(subject, today, this.verdictConfig).message;
  }

  /** Inclusive on both ends, and absent bounds mean unbounded. */
  /**
   * `GET /check-ins/summary` — the totals above Attendance → History.
   *
   * The same filters as the list, so the numbers always describe the rows
   * under them, except that voided visits never count: they are corrections,
   * not attendance. Without one member selected the window must be bounded
   * (at most a year), because the average reads every timed visit in it.
   */
  async summary(filters: CheckInFilters, reach: CheckInReach): Promise<CheckInSummary> {
    if (filters.userId === undefined && (filters.from === undefined || filters.to === undefined)) {
      throw new DomainException(
        'DATE_RANGE_INVALID',
        'Choose a date range, or one member.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const base = this.where({ ...filters, includeVoided: false }, reach);

    const [visits, byTypeRows, memberRows, guestVisits, timed] = await Promise.all([
      this.prisma.checkIn.count({ where: base }),
      this.prisma.checkIn.groupBy({ by: ['entryType'], where: base, _count: { _all: true } }),
      this.prisma.checkIn.groupBy({
        by: ['userId'],
        where: { AND: [base, { userId: { not: null } }] },
      }),
      this.prisma.checkIn.count({ where: { AND: [base, { userId: null }] } }),
      // Two columns only. Closed and not auto-closed: an open visit has no
      // length yet, and one closed at closing time was never timed.
      this.prisma.checkIn.findMany({
        where: { AND: [base, { endedAt: { not: null } }, { autoClosed: false }] },
        select: { occurredAt: true, endedAt: true },
      }),
    ]);

    const byType: CheckInSummary['byType'] = { MEMBERSHIP: 0, WALK_IN: 0, GUEST_PASS: 0 };
    for (const row of byTypeRows) byType[row.entryType] = row._count._all;

    let minutes = 0;
    for (const row of timed) {
      if (row.endedAt !== null)
        minutes += (row.endedAt.getTime() - row.occurredAt.getTime()) / 60_000;
    }

    return {
      visits,
      people: memberRows.length + guestVisits,
      byType,
      averageMinutes: timed.length === 0 ? null : Math.round(minutes / timed.length),
    };
  }

  /**
   * One `where` for the list and the summary, so a filter can never apply to
   * the rows and not to the numbers above them.
   */
  private where(filters: CheckInFilters, reach: CheckInReach): Prisma.CheckInWhereInput {
    this.assertWindow(filters);
    const words = (filters.q ?? '').split(/\s+/).filter((word) => word.length > 0);
    return {
      ...this.reachWhere(reach),
      ...this.dateRange(filters.from, filters.to),
      ...(filters.userId === undefined ? {} : { userId: filters.userId }),
      ...(filters.stationId === undefined ? {} : { stationId: filters.stationId }),
      ...(filters.method === undefined ? {} : { method: filters.method }),
      ...(filters.entryType === undefined ? {} : { entryType: filters.entryType }),
      // Voided rows are a correction, not attendance. Excluded unless asked
      // for, because a report that counted them would overstate the gym's use.
      ...(filters.includeVoided === true ? {} : { voidedAt: null }),
      ...(filters.openOnly === true ? { endedAt: null } : {}),
      // Every word must match the member's first name, last name or code, or a
      // walk-in guest's name — so "ana rey" finds Ana Reyes.
      ...(words.length === 0
        ? {}
        : {
            AND: words.map((word) => ({
              OR: [
                { user: { firstName: { contains: word, mode: 'insensitive' as const } } },
                { user: { lastName: { contains: word, mode: 'insensitive' as const } } },
                { user: { memberCode: { contains: word, mode: 'insensitive' as const } } },
                { guestName: { contains: word, mode: 'insensitive' as const } },
              ],
            })),
          }),
    };
  }

  private reachWhere(reach: CheckInReach): Prisma.CheckInWhereInput {
    return reach.scope === 'ALL' ? {} : { user: coachedMemberWhere(reach.callerId) };
  }

  /**
   * A reversed range is refused rather than read as empty; a range over a year
   * is refused unless it is one member's history, which is always small.
   * Either bound alone stays allowed, as it always has been.
   */
  private assertWindow(filters: CheckInFilters): void {
    if (filters.from === undefined || filters.to === undefined) return;
    const span = civilDaysBetween(filters.from, filters.to);
    if (span < 0) {
      throw new DomainException(
        'DATE_RANGE_INVALID',
        'The start date must be on or before the end date.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (filters.userId === undefined && span > REPORT_MAX_RANGE_DAYS) {
      throw new DomainException(
        'DATE_RANGE_INVALID',
        `Ask for at most ${REPORT_MAX_RANGE_DAYS} days at a time, or pick one member.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private dateRange(
    from: CivilDate | undefined,
    to: CivilDate | undefined,
  ): { businessDate?: Prisma.DateTimeFilter } {
    if (from === undefined && to === undefined) return {};
    return {
      businessDate: {
        ...(from === undefined ? {} : { gte: toDateColumn(from) }),
        ...(to === undefined ? {} : { lte: toDateColumn(to) }),
      },
    };
  }
}
