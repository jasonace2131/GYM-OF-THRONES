import { Injectable } from '@nestjs/common';
import type { MyCheckIn, MyCheckInSummary, PaginatedData } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { civilDateFromPrisma, gymToday, type CivilDate } from '../common/time/gym-time';
import { HEATMAP_WEEKS, summariseCheckIns } from './check-in-summary';

/**
 * Routes 13 and 14 — the member's own attendance.
 *
 * KEYLESS AND HARD-CODED TO THE CALLER, exactly like the rest of `/me`. There
 * is no `userId` parameter anywhere here: a member reading their own history
 * needs no permission, and a route that could name somebody else would need
 * one — at which point it belongs on the staff surface with a scope, not here.
 *
 * Every voided visit is excluded from both. A void is a correction, and a
 * member should not see a visit staff has already established did not happen.
 */
@Injectable()
export class MeCheckInsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
  ) {}

  /** Route 13. */
  async history(
    userId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedData<MyCheckIn>> {
    const where = { userId, voidedAt: null };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.checkIn.findMany({
        where,
        include: { station: { select: { code: true, name: true } } },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        ...paginationSkipTake(query),
      }),
      this.prisma.checkIn.count({ where }),
    ]);

    return paginated(
      rows.map(
        (row): MyCheckIn => ({
          id: row.id,
          occurredAt: row.occurredAt.toISOString(),
          // The ONLY sanctioned way to read a @db.Date back — it comes off the
          // driver at UTC midnight, and any other accessor is a day out for
          // every visit before 08:00 Manila.
          businessDate: civilDateFromPrisma(row.businessDate),
          endedAt: row.endedAt?.toISOString() ?? null,
          durationMinutes:
            row.endedAt === null
              ? null
              : Math.max(
                  0,
                  Math.round((row.endedAt.getTime() - row.occurredAt.getTime()) / 60_000),
                ),
          method: row.method as unknown as MyCheckIn['method'],
          entryType: row.entryType as MyCheckIn['entryType'],
          station: row.station,
        }),
      ),
      total,
      query,
    );
  }

  /**
   * Route 14 — the dashboard's numbers and the heatmap.
   *
   * Reads only `businessDate`, and only inside the heatmap window plus whatever
   * the all-time count needs. The maths lives in a pure function so the streak
   * rules are tested as rules rather than sampled through a database.
   */
  async summary(userId: string, now: Date = new Date()): Promise<MyCheckInSummary> {
    const today = gymToday(now, this.gym.timeZone);

    const rows = await this.prisma.checkIn.findMany({
      where: { userId, voidedAt: null },
      select: { businessDate: true },
      // A hard cap. A heatmap is 26 weeks of squares; a member with a decade of
      // history should not pull a decade of rows to render half a year of them,
      // and `allTime` is a count rather than a length in that case.
      orderBy: { businessDate: 'desc' },
      take: HEATMAP_WEEKS * 7 * 4,
    });

    const visits: CivilDate[] = rows.map((row) => civilDateFromPrisma(row.businessDate));
    const summary = summariseCheckIns(visits, today);

    // `allTime` from a COUNT, not from the capped page above — otherwise a
    // long-standing member's lifetime total silently stops at the cap.
    const allTime = await this.prisma.checkIn.count({ where: { userId, voidedAt: null } });

    return { ...summary, allTime };
  }
}
