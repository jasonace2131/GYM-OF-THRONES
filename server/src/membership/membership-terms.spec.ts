import { DiscountType, MembershipStatus } from '@got/shared';
import { asCivilDate } from '../common/time/gym-time';
import type { CivilDate } from '../common/time/gym-time';
import {
  computeAmounts,
  graceEndsOn,
  holdClawBackDelta,
  holdCompleteDelta,
  holdDaysRequested,
  holdStartDelta,
  planTerm,
  roundHalfUp,
  termEndsOn,
} from './membership-terms';
import type { CurrentTerm } from './membership-terms';

const d = (value: string): CivilDate => asCivilDate(value);

describe('termEndsOn', () => {
  // §5.7.2's four-term Jan-31 table. endsOn is the INCLUSIVE last day of
  // access: anniversary(anchor, startsOn, months) minus one day.
  const jan31: ReadonlyArray<[string, string]> = [
    ['2027-01-31', '2027-02-27'],
    ['2027-02-28', '2027-03-30'],
    ['2027-03-31', '2027-04-29'],
    ['2027-04-30', '2027-05-30'],
  ];

  it.each(jan31)('monthly from a 31st anchor: %s ends %s', (startsOn, expected) => {
    expect(termEndsOn(31, d(startsOn), 1)).toBe(expected);
  });

  it('runs a quarterly term from a 31st anchor', () => {
    expect(termEndsOn(31, d('2027-01-31'), 3)).toBe('2027-04-29');
  });

  it('runs an annual term from a 31st anchor', () => {
    expect(termEndsOn(31, d('2027-01-31'), 12)).toBe('2028-01-30');
  });

  it('runs an annual term across the leap cycle', () => {
    expect(termEndsOn(29, d('2028-02-29'), 12)).toBe('2029-02-27');
    expect(termEndsOn(29, d('2031-02-28'), 12)).toBe('2032-02-28');
  });

  it('runs a plain monthly term from a mid-month anchor', () => {
    expect(termEndsOn(19, d('2026-08-19'), 1)).toBe('2026-09-18');
  });
});

describe('graceEndsOn', () => {
  it('is endsOn plus the row own graceDays, never a stored column', () => {
    expect(graceEndsOn(d('2026-09-18'), 3)).toBe('2026-09-21');
  });

  it('is endsOn itself when the plan grants no grace', () => {
    expect(graceEndsOn(d('2026-09-18'), 0)).toBe('2026-09-18');
  });
});

describe('planTerm', () => {
  const current: CurrentTerm = {
    status: MembershipStatus.ACTIVE,
    endsOn: d('2026-09-18'),
    graceDays: 3,
    billingAnchorDay: 19,
  };

  it('FIRST_TERM starts today and anchors to today', () => {
    expect(planTerm(null, d('2026-08-19'), 1)).toEqual({
      kind: 'FIRST_TERM',
      startsOn: '2026-08-19',
      endsOn: '2026-09-18',
      billingAnchorDay: 19,
    });
  });

  it('RENEWAL_BEFORE_EXPIRY starts at endsOn + 1 and keeps the anchor', () => {
    // Early renewal must never cost days: `today + 1 month` punishes the gym's
    // best-behaved members.
    expect(planTerm(current, d('2026-09-10'), 1)).toEqual({
      kind: 'RENEWAL_BEFORE_EXPIRY',
      startsOn: '2026-09-19',
      endsOn: '2026-10-18',
      billingAnchorDay: 19,
    });
  });

  it('RENEWAL_BEFORE_EXPIRY still applies on the last day of the term', () => {
    expect(planTerm(current, d('2026-09-18'), 1).kind).toBe('RENEWAL_BEFORE_EXPIRY');
  });

  it('RENEWAL_IN_GRACE backdates to endsOn + 1 and keeps the anchor', () => {
    const expired: CurrentTerm = { ...current, status: MembershipStatus.EXPIRED };
    expect(planTerm(expired, d('2026-09-20'), 1)).toEqual({
      kind: 'RENEWAL_IN_GRACE',
      startsOn: '2026-09-19',
      endsOn: '2026-10-18',
      billingAnchorDay: 19,
    });
  });

  it('RENEWAL_IN_GRACE holds on the very last grace day', () => {
    const expired: CurrentTerm = { ...current, status: MembershipStatus.EXPIRED };
    expect(planTerm(expired, d('2026-09-21'), 1).kind).toBe('RENEWAL_IN_GRACE');
  });

  it('REACTIVATION starts today and RE-ANCHORS once grace has run out', () => {
    const expired: CurrentTerm = { ...current, status: MembershipStatus.EXPIRED };
    expect(planTerm(expired, d('2026-09-22'), 1)).toEqual({
      kind: 'REACTIVATION',
      startsOn: '2026-09-22',
      endsOn: '2026-10-21',
      billingAnchorDay: 22,
    });
  });

  it('REACTIVATION applies after CANCELLED even inside the old grace window', () => {
    // Status beats dates here: a cancelled membership has no term to extend.
    const cancelled: CurrentTerm = { ...current, status: MembershipStatus.CANCELLED };
    expect(planTerm(cancelled, d('2026-09-20'), 1)).toEqual({
      kind: 'REACTIVATION',
      startsOn: '2026-09-20',
      endsOn: '2026-10-19',
      billingAnchorDay: 20,
    });
  });

  it('REACTIVATION after CANCELLED re-anchors to a later date', () => {
    const cancelled: CurrentTerm = { ...current, status: MembershipStatus.CANCELLED };
    expect(planTerm(cancelled, d('2026-10-05'), 1)).toEqual({
      kind: 'REACTIVATION',
      startsOn: '2026-10-05',
      endsOn: '2026-11-04',
      billingAnchorDay: 5,
    });
  });

  it('plans a quarterly renewal before expiry', () => {
    expect(planTerm(current, d('2026-09-10'), 3)).toEqual({
      kind: 'RENEWAL_BEFORE_EXPIRY',
      startsOn: '2026-09-19',
      endsOn: '2026-12-18',
      billingAnchorDay: 19,
    });
  });
});

describe('roundHalfUp', () => {
  it.each([
    [0.5, 1],
    [1.5, 2],
    [2.5, 3],
    [1.4999, 1],
    [8035.714285714286, 8036],
    [0, 0],
  ])('rounds %p to %i', (value, expected) => {
    expect(roundHalfUp(value)).toBe(expected);
  });
});

describe('computeAmounts', () => {
  it('SENIOR on a monthly plan, VAT-registered', () => {
    // 80000 / 1.12 = 71428.571… → 71429; 20% of that = 14285.8 → 14286.
    expect(
      computeAmounts({
        priceCentavos: 80000,
        discountType: DiscountType.SENIOR,
        vatRegistered: true,
      }),
    ).toEqual({
      grossCentavos: 80000,
      vatBaseCentavos: 71429,
      discountCentavos: 14286,
      netCentavos: 57143,
      vatExempt: true,
    });
  });

  it('PWD on a monthly plan, NOT VAT-registered', () => {
    expect(
      computeAmounts({
        priceCentavos: 80000,
        discountType: DiscountType.PWD,
        vatRegistered: false,
      }),
    ).toEqual({
      grossCentavos: 80000,
      vatBaseCentavos: 80000,
      discountCentavos: 16000,
      netCentavos: 64000,
      vatExempt: false,
    });
  });

  it('SENIOR on a walk-in, VAT-registered', () => {
    expect(
      computeAmounts({
        priceCentavos: 9000,
        discountType: DiscountType.SENIOR,
        vatRegistered: true,
      }),
    ).toEqual({
      grossCentavos: 9000,
      vatBaseCentavos: 8036,
      discountCentavos: 1607,
      netCentavos: 6429,
      vatExempt: true,
    });
  });

  it('PWD on a quarterly plan, VAT-registered', () => {
    expect(
      computeAmounts({
        priceCentavos: 220000,
        discountType: DiscountType.PWD,
        vatRegistered: true,
      }),
    ).toEqual({
      grossCentavos: 220000,
      vatBaseCentavos: 196429,
      discountCentavos: 39286,
      netCentavos: 157143,
      vatExempt: true,
    });
  });

  it('SENIOR on an annual plan, VAT-registered', () => {
    expect(
      computeAmounts({
        priceCentavos: 750000,
        discountType: DiscountType.SENIOR,
        vatRegistered: true,
      }),
    ).toEqual({
      grossCentavos: 750000,
      vatBaseCentavos: 669643,
      discountCentavos: 133929,
      netCentavos: 535714,
      vatExempt: true,
    });
  });

  it('SENIOR on an annual plan, NOT VAT-registered', () => {
    expect(
      computeAmounts({
        priceCentavos: 750000,
        discountType: DiscountType.SENIOR,
        vatRegistered: false,
      }),
    ).toEqual({
      grossCentavos: 750000,
      vatBaseCentavos: 750000,
      discountCentavos: 150000,
      netCentavos: 600000,
      vatExempt: false,
    });
  });

  it('NONE charges the list price and never exempts VAT', () => {
    expect(
      computeAmounts({
        priceCentavos: 80000,
        discountType: DiscountType.NONE,
        vatRegistered: true,
      }),
    ).toEqual({
      grossCentavos: 80000,
      vatBaseCentavos: 80000,
      discountCentavos: 0,
      netCentavos: 80000,
      vatExempt: false,
    });
  });

  it('a STAFF comp is a full discount down to zero, on the full list price', () => {
    // netCentavos = 0 is legal exactly for PROMO/STAFF/GUEST_PASS/GOODWILL —
    // this is what lets a coach who trains here hold a comped membership
    // instead of a role bypass at the door.
    expect(
      computeAmounts({
        priceCentavos: 80000,
        discountType: DiscountType.STAFF,
        vatRegistered: true,
        operatorDiscountCentavos: 80000,
      }),
    ).toEqual({
      grossCentavos: 80000,
      vatBaseCentavos: 80000,
      discountCentavos: 80000,
      netCentavos: 0,
      vatExempt: false,
    });
  });

  it('a PROMO with no operator amount discounts nothing', () => {
    expect(
      computeAmounts({
        priceCentavos: 220000,
        discountType: DiscountType.PROMO,
        vatRegistered: false,
      }).netCentavos,
    ).toBe(220000);
  });

  it('refuses an operator discount larger than the base', () => {
    expect(() =>
      computeAmounts({
        priceCentavos: 80000,
        discountType: DiscountType.GOODWILL,
        vatRegistered: false,
        operatorDiscountCentavos: 80001,
      }),
    ).toThrow(/PAYMENT_AMOUNT_MISMATCH|discount/i);
  });

  it('net = vatBase − discount in every branch', () => {
    const inputs = [
      DiscountType.NONE,
      DiscountType.SENIOR,
      DiscountType.PWD,
      DiscountType.PROMO,
      DiscountType.STAFF,
      DiscountType.GUEST_PASS,
      DiscountType.GOODWILL,
    ];
    for (const discountType of inputs) {
      for (const vatRegistered of [true, false]) {
        const amounts = computeAmounts({
          priceCentavos: 220000,
          discountType,
          vatRegistered,
          operatorDiscountCentavos: 5000,
        });
        expect(amounts.netCentavos).toBe(amounts.vatBaseCentavos - amounts.discountCentavos);
        expect(Number.isInteger(amounts.netCentavos)).toBe(true);
        expect(amounts.grossCentavos).toBeGreaterThan(0);
        expect(amounts.netCentavos).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('freeze arithmetic', () => {
  it('counts an inclusive hold window', () => {
    expect(holdDaysRequested(d('2026-09-01'), d('2026-09-30'))).toBe(30);
    expect(holdDaysRequested(d('2026-09-01'), d('2026-09-07'))).toBe(7);
  });

  it('applies the whole window when the hold STARTS', () => {
    // Applied at start, not at booking: booking-time application banks days a
    // member has not yet given up, and with a cancellable hold that is a
    // two-call loop that mints free membership.
    expect(holdStartDelta(30)).toEqual({ endsOnDaysDelta: 30, daysAppliedDelta: 30 });
  });

  it('does no arithmetic at all when a hold completes on time', () => {
    expect(holdCompleteDelta()).toEqual({ endsOnDaysDelta: 0, daysAppliedDelta: 0 });
  });

  it('claws back exactly the unused days on early release', () => {
    expect(
      holdClawBackDelta({ endsOn: d('2026-09-30'), daysApplied: 30 }, d('2026-09-11')),
    ).toEqual({ endsOnDaysDelta: -19, daysAppliedDelta: -19 });
  });

  it('claws back nothing when released on the hold last day', () => {
    expect(
      holdClawBackDelta({ endsOn: d('2026-09-30'), daysApplied: 30 }, d('2026-09-30')),
    ).toEqual({ endsOnDaysDelta: 0, daysAppliedDelta: 0 });
  });

  it('claws back nothing when the job is late and today is past the window', () => {
    expect(
      holdClawBackDelta({ endsOn: d('2026-09-30'), daysApplied: 30 }, d('2026-10-05')),
    ).toEqual({ endsOnDaysDelta: 0, daysAppliedDelta: 0 });
  });

  it('cancelling a hold that never started claws back nothing, because nothing was applied', () => {
    expect(holdClawBackDelta({ endsOn: d('2026-09-30'), daysApplied: 0 }, d('2026-08-20'))).toEqual(
      {
        endsOnDaysDelta: 0,
        daysAppliedDelta: 0,
      },
    );
  });

  it('can never claw back more than was applied, so applying twice is unrepresentable', () => {
    const delta = holdClawBackDelta({ endsOn: d('2026-12-31'), daysApplied: 7 }, d('2026-09-01'));
    expect(delta.daysAppliedDelta).toBe(-7);
    expect(delta.endsOnDaysDelta).toBe(-7);
  });
});
