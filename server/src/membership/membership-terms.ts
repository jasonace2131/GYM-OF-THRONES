import { HttpStatus } from '@nestjs/common';
import { MembershipStatus } from '@got/shared';
import {
  AmountsError,
  computeAmounts as sharedComputeAmounts,
  type Amounts,
  type AmountsInput,
} from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import { addDays, anniversary, civilDaysBetween } from '../common/time/gym-time';
import type { CivilDate } from '../common/time/gym-time';

/**
 * The pure billing core: anniversary arithmetic, renewal timing, statutory
 * money and freeze deltas.
 *
 * PURE. No clock, no Prisma, no GymConfigService, no Nest DI. `today` arrives
 * as an argument and every configurable value arrives on an input object. The
 * loading, the transaction and the config read live in the services, which is
 * the same split as PermissionsService / PermissionsGuard. A reviewer who sees
 * `new Date()` or `this.gym.` in this file should reject the change.
 */

/** The INCLUSIVE last day of access for a term. */
export function termEndsOn(anchorDay: number, startsOn: CivilDate, termMonths: number): CivilDate {
  return addDays(anniversary(anchorDay, startsOn, termMonths), -1);
}

/**
 * The last day the door still admits after a term elapsed.
 *
 * Computed, never stored: a stored copy goes stale the moment the nightly job
 * misses a run, which is the exact failure this chunk is designed to survive.
 */
export function graceEndsOn(endsOn: CivilDate, graceDays: number): CivilDate {
  return addDays(endsOn, graceDays);
}

export type TermKind = 'FIRST_TERM' | 'RENEWAL_BEFORE_EXPIRY' | 'RENEWAL_IN_GRACE' | 'REACTIVATION';

export interface CurrentTerm {
  status: MembershipStatus;
  endsOn: CivilDate;
  graceDays: number;
  billingAnchorDay: number;
}

export interface PlannedTerm {
  kind: TermKind;
  startsOn: CivilDate;
  endsOn: CivilDate;
  billingAnchorDay: number;
}

function dayOfMonth(day: CivilDate): number {
  return Number(day.slice(8, 10));
}

/**
 * §5.7.3's four cases, decided by the SERVER — the client never sends a start
 * date.
 *
 * Before expiry and inside grace both start at `endsOn + 1` with the anchor
 * unchanged: early renewal must never cost days, and a member admitted on
 * grace days consumed them. After grace and after CANCELLED are restarts, not
 * renewals — they begin today and re-anchor, and churn reporting depends on
 * the distinction.
 */
export function planTerm(
  current: CurrentTerm | null,
  today: CivilDate,
  termMonths: number,
): PlannedTerm {
  if (current === null) {
    const anchor = dayOfMonth(today);
    return {
      kind: 'FIRST_TERM',
      startsOn: today,
      endsOn: termEndsOn(anchor, today, termMonths),
      billingAnchorDay: anchor,
    };
  }

  if (current.status !== MembershipStatus.CANCELLED) {
    const continuous =
      today <= current.endsOn || today <= graceEndsOn(current.endsOn, current.graceDays);
    if (continuous) {
      const startsOn = addDays(current.endsOn, 1);
      return {
        kind: today <= current.endsOn ? 'RENEWAL_BEFORE_EXPIRY' : 'RENEWAL_IN_GRACE',
        startsOn,
        endsOn: termEndsOn(current.billingAnchorDay, startsOn, termMonths),
        billingAnchorDay: current.billingAnchorDay,
      };
    }
  }

  const anchor = dayOfMonth(today);
  return {
    kind: 'REACTIVATION',
    startsOn: today,
    endsOn: termEndsOn(anchor, today, termMonths),
    billingAnchorDay: anchor,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MONEY ARITHMETIC MOVED TO `@got/shared`'s `money/amounts`, AND THE
 * NAMES STAY HERE.
 *
 * The admin console's amend preview has to show the corrected figure before
 * the operator saves it, and a client-side reimplementation of the statutory
 * 20%-on-the-VAT-exclusive-base rule would be a second thing to get wrong.
 * So the pure core lives in the shared package and both runtimes call it.
 *
 * `Amounts`, `AmountsInput` and `roundHalfUp` are re-exported verbatim. Only
 * `computeAmounts` is wrapped, and only to translate: `@got/shared` cannot
 * import `@nestjs/common`, so it throws `AmountsError`, and the server turns
 * that into the `DomainException` `HttpExceptionFilter` already renders as a
 * 422 `PAYMENT_AMOUNT_MISMATCH`. Every existing caller of this module is
 * untouched, and the behaviour they see is unchanged.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export type { Amounts, AmountsInput } from '@got/shared';
export { roundHalfUp } from '@got/shared';

export function computeAmounts(input: AmountsInput): Amounts {
  try {
    return sharedComputeAmounts(input);
  } catch (caught) {
    if (caught instanceof AmountsError) {
      throw new DomainException(caught.code, caught.message, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    throw caught;
  }
}

export interface HoldDelta {
  endsOnDaysDelta: number;
  daysAppliedDelta: number;
}

/** An inclusive freeze window: both endpoints are frozen days. */
export function holdDaysRequested(startsOn: CivilDate, endsOn: CivilDate): number {
  return civilDaysBetween(startsOn, endsOn) + 1;
}

/** Applied when the hold STARTS, for the whole window, exactly once. */
export function holdStartDelta(daysRequested: number): HoldDelta {
  return { endsOnDaysDelta: daysRequested, daysAppliedDelta: daysRequested };
}

/**
 * Early release, or cancellation while a hold is running.
 *
 * `daysApplied` is what makes this exact rather than recomputed, and clamping
 * to it is what makes a double claw-back unrepresentable.
 */
export function holdClawBackDelta(
  hold: { endsOn: CivilDate; daysApplied: number },
  today: CivilDate,
): HoldDelta {
  const remaining = civilDaysBetween(today, hold.endsOn);
  const unused = Math.min(Math.max(remaining, 0), hold.daysApplied);
  // `-0` is not `toEqual(0)` — normalise the zero case rather than emitting it.
  return unused === 0
    ? { endsOnDaysDelta: 0, daysAppliedDelta: 0 }
    : { endsOnDaysDelta: -unused, daysAppliedDelta: -unused };
}

/** Completing on time is a status flip and an event. No arithmetic at all. */
export function holdCompleteDelta(): HoldDelta {
  return { endsOnDaysDelta: 0, daysAppliedDelta: 0 };
}
