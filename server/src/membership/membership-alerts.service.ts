import { HttpStatus, Injectable } from '@nestjs/common';
import { MembershipStatus, type Prisma } from '@prisma/client';
import type { PaginatedData } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import { addDays, gymToday, toDateColumn } from '../common/time/gym-time';
import type { ScopedWhere } from '../rbac/scope.util';
import { MembershipService, READ_INCLUDE } from './membership.service';
import { toMembershipListItem, type MembershipListItem } from './membership.presenter';
import type { ListMembershipAlertsQueryDto } from './dto/list-membership-alerts-query.dto';

export interface MembershipAlertItem extends MembershipListItem {
  /** When staff archived this term's alert; null while it is open. */
  alertArchivedAt: string | null;
}

/**
 * The Notifications panel's Expiration Alerts, paged on the server
 * (owner, 2026-10-08).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO SEGMENTS, ONE LIST.
 *
 * The panel used to fetch up to fifty "ending soon" and fifty "lapsed" rows and
 * page them in the browser. Lapsed memberships only ever accumulate, so that
 * was a request that grew forever and still could not show everybody.
 *
 * Now one page is read at a time across two segments, in the order a counter
 * works them:
 *   1. ending within the expiring-soon window, SOONEST first;
 *   2. lapsed (ended before today, ACTIVE in grace or EXPIRED), MOST RECENT
 *      first — yesterday's lapse is a phone call, last year's is history.
 * Each segment is counted, and the page is cut across the boundary with
 * skip/take on each, so no query reads more rows than the page shows.
 *
 * ARCHIVED means archived FOR THIS TERM: `expiryAlertArchivedFor` equals
 * `endsOn`. A renewal moves `endsOn`, so the next term's alert reappears
 * without anything clearing the column.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class MembershipAlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly memberships: MembershipService,
  ) {}

  async list(
    query: ListMembershipAlertsQueryDto,
    scope: ScopedWhere<Prisma.MembershipWhereInput>,
    now: Date,
  ): Promise<PaginatedData<MembershipAlertItem>> {
    const today = gymToday(now, this.gym.timeZone);
    const todayColumn = toDateColumn(today);
    const endsOnRef = this.prisma.membership.fields.endsOn;

    const archive: Prisma.MembershipWhereInput = query.archived
      ? { expiryAlertArchivedFor: { equals: endsOnRef } }
      : // Two branches, never a bare NOT: `NOT (a = b)` is NULL when `a` is
        // NULL, and NULL drops the row — every never-archived alert would vanish.
        {
          OR: [
            { expiryAlertArchivedFor: null },
            { NOT: { expiryAlertArchivedFor: { equals: endsOnRef } } },
          ],
        };

    const search: Prisma.MembershipWhereInput =
      query.search === undefined
        ? {}
        : {
            user: {
              OR: [
                { firstName: { contains: query.search, mode: 'insensitive' } },
                { lastName: { contains: query.search, mode: 'insensitive' } },
                { memberCode: { contains: query.search, mode: 'insensitive' } },
                { email: { contains: query.search, mode: 'insensitive' } },
              ],
            },
          };

    // AND, never spread: `search`, `archive` and `scope` can each carry a
    // top-level OR, and a spread would let one silently replace another.
    const ending: Prisma.MembershipWhereInput = {
      AND: [
        {
          endsOn: {
            gte: todayColumn,
            lte: toDateColumn(addDays(today, this.gym.expiringSoonDays)),
          },
        },
        archive,
        search,
        scope,
      ],
    };
    const lapsed: Prisma.MembershipWhereInput = {
      AND: [
        {
          // EXPIRED, and ACTIVE past its end date: in grace, or waiting for the
          // nightly job to mark it. Those are the most urgent calls of all, and
          // the old two-query panel showed them in neither list.
          status: { in: [MembershipStatus.ACTIVE, MembershipStatus.EXPIRED] },
          endsOn: { lt: todayColumn },
        },
        archive,
        search,
        scope,
      ],
    };

    const [endingTotal, lapsedTotal] = await this.prisma.$transaction([
      this.prisma.membership.count({ where: ending }),
      this.prisma.membership.count({ where: lapsed }),
    ]);

    const { skip, take } = paginationSkipTake(query);
    const fromEnding = Math.max(0, Math.min(take, endingTotal - skip));
    const fromLapsed = take - fromEnding;

    const [endingRows, lapsedRows] = await Promise.all([
      fromEnding === 0
        ? Promise.resolve([])
        : this.prisma.membership.findMany({
            where: ending,
            include: READ_INCLUDE,
            orderBy: [{ endsOn: 'asc' }, { id: 'asc' }],
            skip,
            take: fromEnding,
          }),
      fromLapsed === 0 || lapsedTotal === 0
        ? Promise.resolve([])
        : this.prisma.membership.findMany({
            where: lapsed,
            include: READ_INCLUDE,
            orderBy: [{ endsOn: 'desc' }, { id: 'asc' }],
            skip: Math.max(0, skip - endingTotal),
            take: fromLapsed,
          }),
    ]);

    const config = this.memberships.accessConfig;
    return paginated(
      [...endingRows, ...lapsedRows].map((row) => ({
        ...toMembershipListItem(row, today, config),
        alertArchivedAt:
          row.expiryAlertArchivedAt === null ? null : row.expiryAlertArchivedAt.toISOString(),
      })),
      endingTotal + lapsedTotal,
      query,
    );
  }

  /**
   * Archive this term's alert. Idempotent: archiving twice keeps the first
   * stamp, so "archived 9:14" stays true.
   */
  async archive(id: string, now: Date = new Date()): Promise<{ archivedFor: string }> {
    const row = await this.require(id);
    if (row.expiryAlertArchivedFor?.getTime() !== row.endsOn.getTime()) {
      await this.prisma.membership.update({
        where: { id },
        data: { expiryAlertArchivedFor: row.endsOn, expiryAlertArchivedAt: now },
      });
    }
    return { archivedFor: row.endsOn.toISOString().slice(0, 10) };
  }

  /** Put the alert back. Idempotent. */
  async restore(id: string): Promise<{ restored: true }> {
    const row = await this.require(id);
    if (row.expiryAlertArchivedFor !== null) {
      await this.prisma.membership.update({
        where: { id },
        data: { expiryAlertArchivedFor: null, expiryAlertArchivedAt: null },
      });
    }
    return { restored: true };
  }

  private async require(
    id: string,
  ): Promise<{ endsOn: Date; expiryAlertArchivedFor: Date | null }> {
    const row = await this.prisma.membership.findUnique({
      where: { id },
      select: { endsOn: true, expiryAlertArchivedFor: true },
    });
    if (row === null) {
      throw new DomainException(
        'MEMBERSHIP_NOT_FOUND',
        'That membership does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }
}
