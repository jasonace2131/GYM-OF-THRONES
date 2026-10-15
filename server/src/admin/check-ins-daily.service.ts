import { HttpStatus, Injectable } from '@nestjs/common';
import type { DailyCheckInPoint, DailyCheckIns } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DomainException } from '../common/exceptions/domain.exception';
import {
  addDays,
  civilDaysBetween,
  civilDateFromPrisma,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import type { DailyCheckInsQueryDto } from './dto/daily-check-ins-query.dto';

/**
 * The dashboard's attendance trend.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THREE RULES, EACH OF WHICH IS A BUG IF BROKEN SILENTLY.
 *
 * 1. GROUP ON `businessDate`, NEVER ON `occurredAt`.
 *
 *    `businessDate` is `@db.Date` and already holds the gym-local civil date;
 *    `occurredAt` is `@db.Timestamptz(3)`. Bucketing on the timestamp splits a
 *    Manila day at 08:00 local and moves roughly every evening visit onto the
 *    following day — a chart that is wrong every single day, in a way that
 *    looks plausible. `@@index([businessDate])` exists on both tables for
 *    exactly this query and carries the comment saying so.
 *
 * 2. EXCLUDE VOIDED ROWS.
 *
 *    `front-desk.service.ts` already filters `voidedAt: null` when it builds
 *    the counters this chart is rendered beside. A void is the correction of a
 *    mistake; counting it here would make the two disagree on screen.
 *
 * 3. THE RESULT IS DENSE.
 *
 *    Every date in the range is returned, zero-filled. A line chart handed a
 *    sparse series interpolates straight across a closed holiday and draws
 *    attendance that never happened.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Matches `ListMembershipsQueryDto`'s `@Max(90)`. Without a cap,
 * `from=1970-01-01` is a full table scan any authenticated staff account can
 * trigger from a query string.
 */
export const MAX_RANGE_DAYS = 90;

@Injectable()
export class CheckInsDailyService {
  constructor(private readonly prisma: PrismaService) {}

  async daily({ from, to }: DailyCheckInsQueryDto): Promise<DailyCheckIns> {
    const span = civilDaysBetween(from, to);

    if (span < 0) {
      throw new DomainException(
        'REPORT_RANGE_INVALID',
        'The end of the range is before its start.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // `span` is the count of days BETWEEN the bounds, and both are inclusive,
    // so a 90-day window has a span of 89.
    if (span >= MAX_RANGE_DAYS) {
      throw new DomainException(
        'REPORT_RANGE_INVALID',
        `That range is longer than ${MAX_RANGE_DAYS} days. Narrow it and try again.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const window = { gte: toDateColumn(from), lte: toDateColumn(to) };

    // Two queries, not one per day. The unit spec asserts this count so an
    // N+1 introduced later fails a test rather than a production dashboard.
    const [visits, denials] = await Promise.all([
      this.prisma.checkIn.groupBy({
        by: ['businessDate', 'method'],
        where: { businessDate: window, voidedAt: null },
        _count: { _all: true },
      }),
      this.prisma.checkInDenial.groupBy({
        by: ['businessDate'],
        where: { businessDate: window },
        _count: { _all: true },
      }),
    ]);

    const points = new Map<CivilDate, DailyCheckInPoint>();
    for (let day = from; civilDaysBetween(day, to) >= 0; day = addDays(day, 1)) {
      points.set(day, { date: day, total: 0, selfScan: 0, staff: 0, denied: 0 });
    }

    for (const row of visits) {
      const point = points.get(civilDateFromPrisma(row.businessDate));
      // Defensive rather than expected: a row outside the window would mean
      // the WHERE clause and the fill loop disagree, and dropping it silently
      // is better than writing to an undefined bucket.
      if (point === undefined) continue;

      const count = row._count._all;
      point.total += count;
      if (row.method === 'STATION_QR') point.selfScan += count;
      else point.staff += count;
    }

    for (const row of denials) {
      const point = points.get(civilDateFromPrisma(row.businessDate));
      if (point === undefined) continue;
      point.denied += row._count._all;
    }

    return { from, to, days: [...points.values()] };
  }
}
