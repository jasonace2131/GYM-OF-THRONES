import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CheckInRecord, DeskDenial, PaginatedData } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import { gymToday, toDateColumn, type CivilDate } from '../common/time/gym-time';
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
    now: Date = new Date(),
  ): Promise<PaginatedData<CheckInRecord>> {
    const today = gymToday(now, this.gym.timeZone);
    const where: Prisma.CheckInWhereInput = {
      ...this.dateRange(query.from, query.to),
      ...(query.userId === undefined ? {} : { userId: query.userId }),
      ...(query.stationId === undefined ? {} : { stationId: query.stationId }),
      ...(query.method === undefined ? {} : { method: query.method }),
      ...(query.entryType === undefined ? {} : { entryType: query.entryType }),
      // Voided rows are a correction, not attendance. Excluded unless asked
      // for, because a report that counted them would overstate the gym's use.
      ...(query.includeVoided === true ? {} : { voidedAt: null }),
      ...(query.openOnly === true ? { endedAt: null } : {}),
    };

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
  async findOne(id: string, now: Date = new Date()): Promise<CheckInRecord> {
    const row = await this.prisma.checkIn.findUnique({
      where: { id },
      include: { user: MEMBER_INCLUDE, station: { select: { code: true, name: true } } },
    });

    if (row === null) throw new NotFoundException('Check-in not found');
    return toCheckInRecord(row, gymToday(now, this.gym.timeZone), this.verdictConfig);
  }

  /** Route 55 — the number that says whether the door is set right. */
  async listDenials(
    query: ListDenialsQueryDto,
    now: Date = new Date(),
  ): Promise<PaginatedData<DeskDenial>> {
    const today = gymToday(now, this.gym.timeZone);
    const where: Prisma.CheckInDenialWhereInput = {
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
