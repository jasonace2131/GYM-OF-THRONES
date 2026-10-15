import type { Membership, MembershipHold } from '@prisma/client';
import { DenialReason, MembershipStatus } from '@got/shared';
import { asCivilDate } from '../common/time/gym-time';
import { bookingEligibility } from './booking-eligibility';
import { toBookingSubject, toMembershipSnapshot } from './membership.presenter';

/** A `@db.Date` value, the way Prisma returns one: UTC midnight. */
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** A Monthly term, 1–31 Aug 2026. Fully typed, so a schema change breaks here. */
function membershipRow(overrides: Partial<Membership> = {}): Membership {
  return {
    id: 'mem-1',
    userId: 'u-1',
    planId: 'plan-1',
    status: 'ACTIVE',
    planCode: 'MONTHLY',
    planName: 'Monthly',
    planPriceCentavos: 80000,
    termMonths: 1,
    graceDays: 3,
    guestPassesPerTerm: 0,
    startsOn: day('2026-08-01'),
    endsOn: day('2026-08-31'),
    billingAnchorDay: 1,
    joinedOn: day('2026-08-01'),
    cancelRequestedOn: null,
    cancelledOn: null,
    graceAdmissionsThisTerm: 0,
    freezesUsedThisTerm: 0,
    guestPassesRemaining: 0,
    purchasedAt: new Date('2026-08-01T02:00:00.000Z'),
    expiryAlertArchivedFor: null,
    expiryAlertArchivedAt: null,
    createdAt: new Date('2026-08-01T02:00:00.000Z'),
    updatedAt: new Date('2026-08-01T02:00:00.000Z'),
    ...overrides,
  };
}

/** A 7-day freeze booked for 20–26 Aug, not started yet. */
function holdRow(overrides: Partial<MembershipHold> = {}): MembershipHold {
  return {
    id: 'hold-1',
    membershipId: 'mem-1',
    status: 'SCHEDULED',
    startsOn: day('2026-08-20'),
    endsOn: day('2026-08-26'),
    daysRequested: 7,
    daysApplied: 0,
    activeMembershipId: null,
    reason: 'Travel',
    feeWaived: false,
    approvedById: 'staff-1',
    releasedAt: null,
    releasedById: null,
    createdAt: new Date('2026-08-05T02:00:00.000Z'),
    updatedAt: new Date('2026-08-05T02:00:00.000Z'),
    ...overrides,
  };
}

/** Running 10–23 Aug: activation already moved the term's end to 14 Sep. */
const RUNNING = holdRow({
  id: 'hold-running',
  status: 'ACTIVE',
  startsOn: day('2026-08-10'),
  endsOn: day('2026-08-23'),
  daysRequested: 14,
  daysApplied: 14,
  activeMembershipId: 'mem-1',
});

describe('toBookingSubject', () => {
  it('a member who never bought a plan: no snapshot, no holds, no plan code', () => {
    expect(toBookingSubject({ status: 'ACTIVE', membership: null })).toEqual({
      userStatus: 'ACTIVE',
      membership: null,
      scheduledHolds: [],
      planCode: null,
    });
  });

  it('hands the running hold to the snapshot exactly as the door loaders do', () => {
    const membership = membershipRow({ status: 'FROZEN', endsOn: day('2026-09-14') });

    const subject = toBookingSubject({
      status: 'ACTIVE',
      membership: { ...membership, holds: [RUNNING, holdRow({ id: 'hold-booked' })] },
    });

    // One snapshot for both ladders: the booking one must not see a different
    // running hold from the one the door sees.
    expect(subject.membership).toEqual(toMembershipSnapshot(membership, RUNNING));
    expect(subject.membership?.hold).toEqual({ startsOn: '2026-08-10', endsOn: '2026-08-23' });
  });

  it('turns every booked freeze into a civil-dated window with its stored length', () => {
    const subject = toBookingSubject({
      status: 'ACTIVE',
      membership: {
        ...membershipRow(),
        holds: [
          holdRow(),
          // Read as stored, never recomputed from the window: the projection
          // must add exactly what activation will.
          holdRow({ id: 'hold-2', startsOn: day('2026-09-10'), endsOn: day('2026-09-16') }),
        ],
      },
    });

    expect(subject.membership?.hold).toBeNull();
    expect(subject.scheduledHolds).toEqual([
      { startsOn: '2026-08-20', endsOn: '2026-08-26', daysRequested: 7 },
      { startsOn: '2026-09-10', endsOn: '2026-09-16', daysRequested: 7 },
    ]);
  });

  it('drops COMPLETED and CANCELLED holds even when an include loaded them', () => {
    // Released early on 12 Aug: COMPLETED, but its endsOn still reads 23 Aug.
    const released = holdRow({
      id: 'hold-released',
      status: 'COMPLETED',
      startsOn: day('2026-08-10'),
      endsOn: day('2026-08-23'),
      releasedAt: new Date('2026-08-12T02:00:00.000Z'),
      releasedById: 'staff-1',
    });
    const withdrawn = holdRow({
      id: 'hold-cancelled',
      status: 'CANCELLED',
      releasedAt: new Date('2026-08-06T02:00:00.000Z'),
      releasedById: 'staff-1',
    });

    const subject = toBookingSubject({
      status: 'ACTIVE',
      membership: { ...membershipRow(), holds: [released, withdrawn] },
    });

    expect(subject.membership?.hold).toBeNull();
    expect(subject.scheduledHolds).toEqual([]);
    // …so the stale window freezes nobody: back in on the 15th, as released.
    expect(bookingEligibility(subject, asCivilDate('2026-08-15')).eligible).toBe(true);
  });

  it("carries the membership's snapshot plan code, for the booking window", () => {
    const subject = toBookingSubject({
      status: 'ACTIVE',
      membership: { ...membershipRow({ planCode: 'QUARTERLY' }), holds: [] },
    });
    expect(subject.planCode).toBe('QUARTERLY');
  });

  it("passes the account's status through for the ladder's gate", () => {
    const subject = toBookingSubject({
      status: 'SUSPENDED',
      membership: { ...membershipRow(), holds: [] },
    });
    expect(subject.userStatus).toBe('SUSPENDED');
    expect(bookingEligibility(subject, asCivilDate('2026-08-14')).reason).toBe(
      DenialReason.ACCOUNT_SUSPENDED,
    );
  });

  it('feeds the ladder a frozen member it can project past the running hold', () => {
    const subject = toBookingSubject({
      status: 'ACTIVE',
      membership: {
        ...membershipRow({ status: 'FROZEN', endsOn: day('2026-09-14') }),
        holds: [RUNNING],
      },
    });

    expect(subject.membership?.status).toBe(MembershipStatus.FROZEN);
    expect(bookingEligibility(subject, asCivilDate('2026-08-20'))).toEqual({
      eligible: false,
      reason: DenialReason.MEMBERSHIP_FROZEN,
      relevantDate: '2026-08-23',
      coversUntil: '2026-09-14',
    });
    expect(bookingEligibility(subject, asCivilDate('2026-08-25')).eligible).toBe(true);
  });
});
