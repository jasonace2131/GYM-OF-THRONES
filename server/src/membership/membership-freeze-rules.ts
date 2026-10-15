import { HttpStatus } from '@nestjs/common';
import { MembershipStatus } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import { addDays, civilDaysBetween, type CivilDate } from '../common/time/gym-time';

/**
 * §5.6's eligibility table, as one pure assertion.
 *
 * No clock, no Prisma, no GymConfigService: `today` is an argument and every
 * bound arrives on `cfg`, so the whole table is testable without a fixture and
 * the service keeps the loading. A reviewer who sees `new Date()` or `this.gym.`
 * in this file should reject the change.
 */

/** Members phone ahead before travelling; beyond this it is a cancellation. */
export const FREEZE_MAX_LEAD_DAYS = 60;

export interface FreezeConfig {
  minDays: number;
  maxDays: number;
  annualCapDays: number;
}

export interface FreezeRequest {
  status: MembershipStatus;
  planFreezable: boolean;
  freezesUsedThisTerm: number;
  /** The requested hold window, inclusive. */
  startsOn: CivilDate;
  endsOn: CivilDate;
  today: CivilDate;
  /** Days already held across holds overlapping [today − 365, today]. */
  rollingHoldDaysLast365: number;
}

export function assertFreezeAllowed(request: FreezeRequest, cfg: FreezeConfig): void {
  if (!request.planFreezable) {
    throw new DomainException(
      'PLAN_NOT_FREEZABLE',
      'This plan cannot be frozen. A monthly member simply renews later.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  if (request.status !== MembershipStatus.ACTIVE) {
    throw new DomainException(
      'MEMBERSHIP_NOT_ACTIVE',
      `A ${request.status} membership cannot be frozen — freeze is a benefit of a current term.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  if (request.freezesUsedThisTerm > 0) {
    throw new DomainException(
      'FREEZE_ALREADY_USED_THIS_TERM',
      'This term has already used its one freeze.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  if (request.startsOn < request.today) {
    throw new DomainException(
      'FREEZE_WINDOW_INVALID',
      'A freeze cannot be backdated. Use comp days for a past absence.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  if (request.startsOn > addDays(request.today, FREEZE_MAX_LEAD_DAYS)) {
    throw new DomainException(
      'FREEZE_WINDOW_INVALID',
      `A freeze may be scheduled at most ${FREEZE_MAX_LEAD_DAYS} days ahead.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  const days = civilDaysBetween(request.startsOn, request.endsOn) + 1;
  if (days < cfg.minDays || days > cfg.maxDays) {
    throw new DomainException(
      'FREEZE_WINDOW_INVALID',
      `A freeze runs ${cfg.minDays}–${cfg.maxDays} days; this one is ${days}.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  if (request.rollingHoldDaysLast365 + days > cfg.annualCapDays) {
    throw new DomainException(
      'MEMBERSHIP_FREEZE_LIMIT',
      `That would total ${request.rollingHoldDaysLast365 + days} frozen days in 365; ` +
        `the cap is ${cfg.annualCapDays}.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
