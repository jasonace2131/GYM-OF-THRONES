import { HttpStatus } from '@nestjs/common';
import { MembershipStatus } from '@got/shared';
import { asCivilDate } from '../common/time/gym-time';
import { DomainException } from '../common/exceptions/domain.exception';
import {
  assertFreezeAllowed,
  type FreezeConfig,
  type FreezeRequest,
} from './membership-freeze-rules';

const CFG: FreezeConfig = { minDays: 7, maxDays: 90, annualCapDays: 90 };
const TODAY = asCivilDate('2026-08-19');

function request(overrides: Partial<FreezeRequest> = {}): FreezeRequest {
  return {
    status: MembershipStatus.ACTIVE,
    planFreezable: true,
    freezesUsedThisTerm: 0,
    startsOn: asCivilDate('2026-09-01'),
    endsOn: asCivilDate('2026-09-14'),
    today: TODAY,
    rollingHoldDaysLast365: 0,
    ...overrides,
  };
}

function codeOf(run: () => void): { code: string; status: number } {
  try {
    run();
  } catch (error) {
    if (!(error instanceof DomainException)) throw error;
    return { code: error.code, status: error.getStatus() };
  }
  throw new Error('expected assertFreezeAllowed to throw');
}

describe('assertFreezeAllowed', () => {
  it('accepts a 14-day hold on a freezable ACTIVE membership', () => {
    expect(() => assertFreezeAllowed(request(), CFG)).not.toThrow();
  });

  it('accepts the exact minimum and the exact maximum window', () => {
    expect(() =>
      assertFreezeAllowed(
        request({ startsOn: asCivilDate('2026-09-01'), endsOn: asCivilDate('2026-09-07') }),
        CFG,
      ),
    ).not.toThrow();
    expect(() =>
      assertFreezeAllowed(
        request({ startsOn: asCivilDate('2026-09-01'), endsOn: asCivilDate('2026-11-29') }),
        CFG,
      ),
    ).not.toThrow();
  });

  it('refuses a non-freezable plan — Monthly renews later instead', () => {
    expect(codeOf(() => assertFreezeAllowed(request({ planFreezable: false }), CFG))).toEqual({
      code: 'PLAN_NOT_FREEZABLE',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  });

  it.each([MembershipStatus.EXPIRED, MembershipStatus.CANCELLED, MembershipStatus.FROZEN])(
    'refuses a %s membership: you cannot pause a term you have not paid for',
    (status) => {
      expect(codeOf(() => assertFreezeAllowed(request({ status }), CFG)).code).toBe(
        'MEMBERSHIP_NOT_ACTIVE',
      );
    },
  );

  it('refuses a second freeze in one term', () => {
    expect(codeOf(() => assertFreezeAllowed(request({ freezesUsedThisTerm: 1 }), CFG)).code).toBe(
      'FREEZE_ALREADY_USED_THIS_TERM',
    );
  });

  it('refuses a backdated hold — a backdated freeze is a refund with no audit trail', () => {
    expect(
      codeOf(() =>
        assertFreezeAllowed(
          request({ startsOn: asCivilDate('2026-08-18'), endsOn: asCivilDate('2026-09-01') }),
          CFG,
        ),
      ).code,
    ).toBe('FREEZE_WINDOW_INVALID');
  });

  it('accepts a hold scheduled exactly 60 days out and refuses 61', () => {
    expect(() =>
      assertFreezeAllowed(
        request({ startsOn: asCivilDate('2026-10-18'), endsOn: asCivilDate('2026-10-31') }),
        CFG,
      ),
    ).not.toThrow();
    expect(
      codeOf(() =>
        assertFreezeAllowed(
          request({ startsOn: asCivilDate('2026-10-19'), endsOn: asCivilDate('2026-11-01') }),
          CFG,
        ),
      ).code,
    ).toBe('FREEZE_WINDOW_INVALID');
  });

  it('refuses 6 days and 91 days', () => {
    expect(
      codeOf(() =>
        assertFreezeAllowed(
          request({ startsOn: asCivilDate('2026-09-01'), endsOn: asCivilDate('2026-09-06') }),
          CFG,
        ),
      ).code,
    ).toBe('FREEZE_WINDOW_INVALID');
    expect(
      codeOf(() =>
        assertFreezeAllowed(
          request({ startsOn: asCivilDate('2026-09-01'), endsOn: asCivilDate('2026-11-30') }),
          CFG,
        ),
      ).code,
    ).toBe('FREEZE_WINDOW_INVALID');
  });

  it('refuses when the rolling 365-day cap would be exceeded, counting this request', () => {
    expect(() => assertFreezeAllowed(request({ rollingHoldDaysLast365: 76 }), CFG)).not.toThrow();
    expect(codeOf(() => assertFreezeAllowed(request({ rollingHoldDaysLast365: 77 }), CFG))).toEqual(
      {
        code: 'MEMBERSHIP_FREEZE_LIMIT',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      },
    );
  });
});
