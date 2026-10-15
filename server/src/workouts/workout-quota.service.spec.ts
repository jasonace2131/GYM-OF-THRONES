import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { WORKOUT_AI_DAILY_LIMIT } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import type { GymConfigService } from '../config/gym.config';
import type { PrismaService } from '../prisma/prisma.service';
import { WorkoutQuotaService } from './workout-quota.service';

/**
 * The AI-action ledger (feat/member-workouts): 8 per member per GYM day,
 * charged with a conditional update so a race cannot overspend, refunded
 * to the day that was charged, floored at zero.
 */
const MEMBER = 'm0000000-0000-4000-8000-000000000001';

describe('WorkoutQuotaService', () => {
  let quota: {
    createMany: jest.Mock;
    updateMany: jest.Mock;
    findUnique: jest.Mock;
  };
  let service: WorkoutQuotaService;

  const tx = (): Prisma.TransactionClient =>
    ({ workoutAiQuota: quota }) as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    quota = {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ used: 3 }),
    };
    service = new WorkoutQuotaService(
      { workoutAiQuota: quota } as unknown as PrismaService,
      { timeZone: 'Asia/Manila' } as unknown as GymConfigService,
    );
  });

  describe('the gym day', () => {
    it("is Manila's date, not UTC's", () => {
      // 23:30 Manila on the 26th is 15:30 UTC; 00:30 on the 27th is 16:30 UTC.
      expect(service.dayOf(new Date('2026-09-26T15:30:00.000Z'))).toBe('2026-09-26');
      expect(service.dayOf(new Date('2026-09-26T16:30:00.000Z'))).toBe('2026-09-27');
    });

    it('resets at the next Manila midnight, as an instant', () => {
      const view = service.toView(2, new Date('2026-09-26T02:00:00.000Z'));
      expect(view).toEqual({
        used: 2,
        limit: WORKOUT_AI_DAILY_LIMIT,
        remaining: WORKOUT_AI_DAILY_LIMIT - 2,
        resetsAt: '2026-09-26T16:00:00.000Z',
      });
    });

    it('never reports negative remaining', () => {
      expect(service.toView(9, new Date('2026-09-26T02:00:00.000Z')).remaining).toBe(0);
    });
  });

  describe('charge', () => {
    it('claims the day row without throwing on a duplicate, then increments conditionally', async () => {
      const now = new Date('2026-09-26T02:00:00.000Z');
      quota.findUnique.mockResolvedValue({ used: 4 });

      const view = await service.charge(tx(), MEMBER, now);

      expect(quota.createMany).toHaveBeenCalledWith({
        data: [{ memberId: MEMBER, day: new Date('2026-09-26T00:00:00.000Z'), used: 0 }],
        skipDuplicates: true,
      });
      expect(quota.updateMany).toHaveBeenCalledWith({
        where: {
          memberId: MEMBER,
          day: new Date('2026-09-26T00:00:00.000Z'),
          used: { lt: WORKOUT_AI_DAILY_LIMIT },
        },
        data: { used: { increment: 1 } },
      });
      expect(view.used).toBe(4);
      expect(view.remaining).toBe(4);
    });

    it('answers 429 WORKOUT_AI_LIMIT with the member copy when nothing was left to spend', async () => {
      quota.updateMany.mockResolvedValue({ count: 0 });

      const caught = await service.charge(tx(), MEMBER, new Date('2026-09-26T02:00:00.000Z')).then(
        () => null,
        (error: unknown) => error,
      );

      expect(caught).toBeInstanceOf(DomainException);
      expect(caught).toMatchObject({
        code: 'WORKOUT_AI_LIMIT',
        message: "You've used today's 8 AI actions. They reset at midnight.",
      });
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(quota.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('refund', () => {
    it('gives one back to the day that was charged, never below zero', async () => {
      // Charged at 23:59 Manila on the 26th; refunded after midnight.
      await service.refund(MEMBER, new Date('2026-09-26T15:59:00.000Z'));

      expect(quota.updateMany).toHaveBeenCalledWith({
        where: { memberId: MEMBER, day: new Date('2026-09-26T00:00:00.000Z'), used: { gt: 0 } },
        data: { used: { decrement: 1 } },
      });
    });
  });

  describe('view', () => {
    it("reads today's row, or reports nothing spent", async () => {
      const now = new Date('2026-09-26T02:00:00.000Z');
      quota.findUnique.mockResolvedValue(null);
      expect((await service.view(MEMBER, now)).used).toBe(0);

      quota.findUnique.mockResolvedValue({ used: 7 });
      expect(await service.view(MEMBER, now)).toMatchObject({ used: 7, remaining: 1 });
    });
  });
});
