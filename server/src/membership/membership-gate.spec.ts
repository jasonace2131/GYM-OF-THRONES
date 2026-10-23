import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MembershipStatus } from '@got/shared';
import { asCivilDate } from '../common/time/gym-time';
import type { CivilDate } from '../common/time/gym-time';
import type { MembershipSnapshot } from './access-verdict';
import type { BookingSubject } from './booking-eligibility';
import { hasActiveMembership, isMembershipGated, memberAccess } from './membership-gate';

const d = (value: string): CivilDate => asCivilDate(value);

/** A Monthly term, 1–31 Aug 2026 (3 grace days), nobody frozen, nobody leaving. */
function snapshot(overrides: Partial<MembershipSnapshot> = {}): MembershipSnapshot {
  return {
    status: MembershipStatus.ACTIVE,
    startsOn: d('2026-08-01'),
    endsOn: d('2026-08-31'),
    graceDays: 3,
    graceAdmissionsThisTerm: 0,
    cancelRequestedOn: null,
    planName: 'Monthly',
    planPriceCentavos: 80000,
    hold: null,
    ...overrides,
  };
}

function subject(overrides: Partial<BookingSubject> = {}): BookingSubject {
  return {
    userStatus: 'ACTIVE',
    membership: snapshot(),
    scheduledHolds: [],
    planCode: 'MONTHLY',
    ...overrides,
  };
}

/**
 * "Has a membership" = ACTIVE only (owner, 2026-10-17): the class-booking
 * rule of 2026-10-11, judged on today. Grace, day pass, frozen, expired,
 * cancelled and none do not count.
 */
describe('hasActiveMembership', () => {
  it('is true for a member inside an active term', () => {
    expect(hasActiveMembership(subject(), d('2026-08-14'))).toBe(true);
  });

  it('is true on the last day of the term', () => {
    expect(hasActiveMembership(subject(), d('2026-08-31'))).toBe(true);
  });

  it('is false on a grace day, even though the door would still admit them', () => {
    expect(hasActiveMembership(subject(), d('2026-09-01'))).toBe(false);
  });

  it('is false for a walk-in on a day pass (no membership row at all)', () => {
    expect(
      hasActiveMembership(subject({ membership: null, planCode: null }), d('2026-08-14')),
    ).toBe(false);
  });

  it('is false while frozen', () => {
    const frozen = snapshot({
      status: MembershipStatus.FROZEN,
      endsOn: d('2026-09-14'),
      hold: { startsOn: d('2026-08-10'), endsOn: d('2026-08-23') },
    });
    expect(hasActiveMembership(subject({ membership: frozen }), d('2026-08-20'))).toBe(false);
  });

  it('is false for an expired membership', () => {
    const expired = snapshot({ status: MembershipStatus.EXPIRED, endsOn: d('2026-07-31') });
    expect(hasActiveMembership(subject({ membership: expired }), d('2026-08-14'))).toBe(false);
  });

  it('is false for a cancelled membership', () => {
    const cancelled = snapshot({ status: MembershipStatus.CANCELLED });
    expect(hasActiveMembership(subject({ membership: cancelled }), d('2026-08-14'))).toBe(false);
  });

  it('is false for somebody who never had one', () => {
    expect(hasActiveMembership(null, d('2026-08-14'))).toBe(false);
    expect(hasActiveMembership(subject({ membership: null }), d('2026-08-14'))).toBe(false);
  });

  it('is false for a suspended account, whatever the plan says', () => {
    expect(hasActiveMembership(subject({ userStatus: 'SUSPENDED' }), d('2026-08-14'))).toBe(false);
  });
});

describe('isMembershipGated', () => {
  it('gates a member acting on their own account', () => {
    expect(isMembershipGated('CLIENT')).toBe(true);
  });

  it('never gates staff, who use these routes for their work', () => {
    for (const role of ['FRONT_DESK', 'COACH', 'ADMIN', 'DEV'] as const) {
      expect([role, isMembershipGated(role)]).toEqual([role, false]);
    }
  });
});

describe('memberAccess — what the portal is told', () => {
  const today = d('2026-08-14');

  it('is FULL for an active member', () => {
    expect(memberAccess('CLIENT', subject(), today)).toBe('FULL');
  });

  it('is FULL for staff, whatever their own membership', () => {
    expect(memberAccess('COACH', null, today)).toBe('FULL');
    expect(memberAccess('ADMIN', subject({ membership: null }), today)).toBe('FULL');
  });

  it('is LOCKED for a member who never had one', () => {
    expect(memberAccess('CLIENT', null, today)).toBe('LOCKED');
    expect(memberAccess('CLIENT', subject({ membership: null }), today)).toBe('LOCKED');
  });

  it('is READ_ONLY for a member whose membership is not active today', () => {
    const expired = snapshot({ status: MembershipStatus.EXPIRED, endsOn: d('2026-07-31') });
    expect(memberAccess('CLIENT', subject({ membership: expired }), today)).toBe('READ_ONLY');
    // A grace day: the door admits them, the features do not.
    expect(memberAccess('CLIENT', subject(), d('2026-09-01'))).toBe('READ_ONLY');
  });
});

describe('membership-gate.ts stays pure', () => {
  const source = readFileSync(join(__dirname, 'membership-gate.ts'), 'utf8');

  it('reads no clock, no config and no database', () => {
    expect(source).not.toMatch(/new Date\(/);
    expect(source).not.toMatch(/Date\.now\(/);
    expect(source).not.toMatch(/GymConfigService/);
    expect(source).not.toMatch(/PrismaService/);
  });

  it('writes no second definition of "active": it asks bookingEligibility', () => {
    expect(source).toMatch(/bookingEligibility\(/);
  });
});
