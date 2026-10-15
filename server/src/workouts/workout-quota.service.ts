import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { WORKOUT_AI_DAILY_LIMIT, type WorkoutAiQuotaView } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import {
  addDays,
  gymToday,
  toDateColumn,
  zonedTimeToInstant,
  type CivilDate,
} from '../common/time/gym-time';
import { GymConfigService } from '../config/gym.config';
import { PrismaService } from '../prisma/prisma.service';

/** The member's words when the day's allowance is spent. */
export const AI_LIMIT_MESSAGE = `You've used today's ${WORKOUT_AI_DAILY_LIMIT} AI actions. They reset at midnight.`;

/**
 * The AI-action ledger (feat/member-workouts).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EIGHT PER MEMBER PER GYM DAY, AND THE CHARGE CANNOT OVERSPEND.
 *
 * The day is `gymToday` — Manila's date, not the server's — so the reset is
 * the midnight the member expects. The charge is two statements inside the
 * caller's transaction: claim the day row (`createMany … skipDuplicates`,
 * never a caught unique violation — Postgres would abort the transaction and
 * every later statement on it dies with 25P02), then a conditional
 * `updateMany … WHERE used < limit`. Two taps racing for the last action
 * serialise on the row lock and exactly one wins; the loser's `count` is 0
 * and becomes the 429.
 *
 * A refund goes to the day that was CHARGED, not today: a generation started
 * at 23:59 and failed at 00:01 gives its action back to the 23:59 ledger,
 * and the `used > 0` guard (plus the CHECK) keeps it at zero or above.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class WorkoutQuotaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
  ) {}

  dayOf(now: Date): CivilDate {
    return gymToday(now, this.gym.timeZone);
  }

  /** Charge one action inside `tx`. Throws 429 WORKOUT_AI_LIMIT when none is left. */
  async charge(
    tx: Prisma.TransactionClient,
    memberId: string,
    now: Date,
  ): Promise<WorkoutAiQuotaView> {
    const day = toDateColumn(this.dayOf(now));
    await tx.workoutAiQuota.createMany({
      data: [{ memberId, day, used: 0 }],
      skipDuplicates: true,
    });
    const { count } = await tx.workoutAiQuota.updateMany({
      where: { memberId, day, used: { lt: WORKOUT_AI_DAILY_LIMIT } },
      data: { used: { increment: 1 } },
    });
    if (count === 0) {
      throw new DomainException('WORKOUT_AI_LIMIT', AI_LIMIT_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
    }
    const row = await tx.workoutAiQuota.findUnique({
      where: { memberId_day: { memberId, day } },
      select: { used: true },
    });
    return this.toView(row?.used ?? 1, now);
  }

  /** One action back to the day `chargedAt` fell on. Floored at zero. */
  async refund(memberId: string, chargedAt: Date): Promise<void> {
    await this.prisma.workoutAiQuota.updateMany({
      where: { memberId, day: toDateColumn(this.dayOf(chargedAt)), used: { gt: 0 } },
      data: { used: { decrement: 1 } },
    });
  }

  async view(memberId: string, now: Date): Promise<WorkoutAiQuotaView> {
    const row = await this.prisma.workoutAiQuota.findUnique({
      where: { memberId_day: { memberId, day: toDateColumn(this.dayOf(now)) } },
      select: { used: true },
    });
    return this.toView(row?.used ?? 0, now);
  }

  toView(used: number, now: Date): WorkoutAiQuotaView {
    const today = this.dayOf(now);
    return {
      used,
      limit: WORKOUT_AI_DAILY_LIMIT,
      remaining: Math.max(0, WORKOUT_AI_DAILY_LIMIT - used),
      resetsAt: zonedTimeToInstant(addDays(today, 1), '00:00', this.gym.timeZone).toISOString(),
    };
  }
}
