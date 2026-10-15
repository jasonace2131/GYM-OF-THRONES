import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toDateColumn, type CivilDate } from '../common/time/gym-time';

/**
 * The seam accessVerdict's `dayPassValidToday` boolean is filled from.
 *
 * It exists NOW, returns false NOW, and is swapped in Chunk 2 for a read of
 * today's WALK_IN CheckIn. That is what stops anyone "restoring" the DayPass
 * table the name implies: there is no DayPass model, a walk-in is a CheckIn plus
 * a Payment, and the verdict takes a boolean precisely so this chunk carries no
 * dependency on the attendance schema.
 */
export const DAY_PASS_RESOLVER = Symbol('DAY_PASS_RESOLVER');

export interface DayPassResolver {
  /**
   * `client` lets the caller run this read INSIDE its own write transaction.
   * `POST /checkin` must: the verdict is re-evaluated inside the transaction
   * (§5.4.5), and a day-pass read on a separate connection would reopen
   * exactly the TOCTOU window that re-evaluation exists to close.
   */
  validToday(userId: string, today: CivilDate, client?: Prisma.TransactionClient): Promise<boolean>;
}

/**
 * Chunk 1's implementation. Kept, and still bound in unit tests that must not
 * reach Postgres — the production binding moved to `WalkInDayPassResolver`
 * below.
 */
@Injectable()
export class NoDayPassesResolver implements DayPassResolver {
  // Not `async`: there is nothing to await, and an async method with no await
  // is a lint error the moment anyone looks at this file.
  validToday(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * Chunk 2's implementation: a walk-in already paid for today.
 *
 * THE ENTITLEMENT IS THE `CheckIn` ROW. There is no `DayPass` model, there
 * never was, and none is introduced here — a walk-in is a sale plus an entry,
 * and a second entitlement table would be a second place to ask "may this
 * person train today", which is exactly the disagreement §5.4 exists to
 * prevent.
 *
 * `voidedAt: null` is not decoration. A voided walk-in is a refunded sale, and
 * reading it as a live entitlement would let a member get the money back and
 * keep the day.
 *
 * `businessDate` is written and compared as a `@db.Date` at UTC midnight via
 * `toDateColumn` — never as a raw `Date`, which for every entry before 08:00
 * Manila lands on the previous calendar day.
 */
@Injectable()
export class WalkInDayPassResolver implements DayPassResolver {
  constructor(private readonly prisma: PrismaService) {}

  async validToday(
    userId: string,
    today: CivilDate,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    const paid = await client.checkIn.count({
      where: {
        userId,
        entryType: 'WALK_IN',
        businessDate: toDateColumn(today),
        voidedAt: null,
      },
    });
    return paid > 0;
  }
}
