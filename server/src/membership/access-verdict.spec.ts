import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccessVerdict, DenialReason, MembershipStatus } from '@got/shared';
import type { AccessDecision, AllowReason } from '@got/shared';
import { asCivilDate, gymToday } from '../common/time/gym-time';
import type { CivilDate } from '../common/time/gym-time';
import { accessVerdict, effectiveStatus } from './access-verdict';
import type { AccessSubject, AccessVerdictConfig, MembershipSnapshot } from './access-verdict';

const d = (value: string): CivilDate => asCivilDate(value);
const MANILA = 'Asia/Manila';
const CFG: AccessVerdictConfig = { expiringSoonDays: 7, graceAdmissionsMax: 3 };

function snapshot(overrides: Partial<MembershipSnapshot> = {}): MembershipSnapshot {
  return {
    status: MembershipStatus.ACTIVE,
    startsOn: d('2026-08-01'),
    endsOn: d('2026-08-28'),
    graceDays: 3,
    graceAdmissionsThisTerm: 0,
    cancelRequestedOn: null,
    planName: 'Monthly',
    planPriceCentavos: 80000,
    hold: null,
    ...overrides,
  };
}

function subject(overrides: Partial<AccessSubject> = {}): AccessSubject {
  return {
    userStatus: 'ACTIVE',
    membership: snapshot(),
    dayPassValidToday: false,
    ...overrides,
  };
}

describe('accessVerdict — the eleven cases the desk actually sees', () => {
  const cases: ReadonlyArray<
    [string, AccessSubject, string, AccessDecision, AllowReason | DenialReason, string]
  > = [
    ['active, mid-term', subject(), '2026-08-14', 'ALLOW', 'MEMBERSHIP_ACTIVE', 'NONE'],
    [
      'active, 5 days left',
      subject({ membership: snapshot({ endsOn: d('2026-08-31') }) }),
      '2026-08-26',
      'ALLOW',
      'MEMBERSHIP_EXPIRING_SOON',
      'RENEW',
    ],
    [
      'last day',
      subject({ membership: snapshot({ endsOn: d('2026-08-31') }) }),
      '2026-08-31',
      'ALLOW',
      'MEMBERSHIP_EXPIRES_TODAY',
      'RENEW',
    ],
    [
      'notice given, term still running',
      subject({ membership: snapshot({ cancelRequestedOn: d('2026-08-10') }) }),
      '2026-08-14',
      'ALLOW',
      'MEMBERSHIP_ENDING',
      'NONE',
    ],
    [
      'grace, one admission left',
      subject({
        membership: snapshot({
          status: MembershipStatus.EXPIRED,
          endsOn: d('2026-08-16'),
          graceAdmissionsThisTerm: 2,
        }),
      }),
      '2026-08-18',
      'GRACE',
      'MEMBERSHIP_IN_GRACE',
      'RENEW',
    ],
    [
      'expired past grace',
      subject({
        membership: snapshot({ status: MembershipStatus.EXPIRED, endsOn: d('2026-08-12') }),
      }),
      '2026-08-18',
      'DENY',
      DenialReason.MEMBERSHIP_EXPIRED,
      'RENEW',
    ],
    [
      'frozen',
      subject({
        membership: snapshot({
          status: MembershipStatus.FROZEN,
          hold: { startsOn: d('2026-08-01'), endsOn: d('2026-10-01') },
        }),
      }),
      '2026-08-18',
      'DENY',
      DenialReason.MEMBERSHIP_FROZEN,
      'OVERRIDE',
    ],
    [
      'cancelled',
      subject({
        membership: snapshot({ status: MembershipStatus.CANCELLED, endsOn: d('2026-08-03') }),
      }),
      '2026-08-18',
      'DENY',
      DenialReason.MEMBERSHIP_CANCELLED,
      'RENEW',
    ],
    [
      'no membership',
      subject({ membership: null }),
      '2026-08-18',
      'DENY',
      DenialReason.NO_MEMBERSHIP,
      'RENEW',
    ],
    [
      'day pass bought today',
      subject({ membership: null, dayPassValidToday: true }),
      '2026-08-18',
      'ALLOW',
      'DAY_PASS_VALID',
      'NONE',
    ],
    [
      'account suspended',
      subject({ userStatus: 'SUSPENDED' }),
      '2026-08-18',
      'DENY',
      DenialReason.ACCOUNT_SUSPENDED,
      'MANAGER',
    ],
  ];

  it.each(cases)('%s', (_label, subj, today, decision, reason, offer) => {
    const result = accessVerdict(subj, d(today), CFG);
    expect(result.decision).toBe(decision);
    expect(result.allowReason ?? result.denialReason).toBe(reason);
    expect(result.offer).toBe(offer);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('maps ALLOW to ALLOWED and GRACE to ALLOWED_IN_GRACE, and DENY to null', () => {
    expect(accessVerdict(subject(), d('2026-08-14'), CFG).verdict).toBe(AccessVerdict.ALLOWED);
    expect(
      accessVerdict(
        subject({
          membership: snapshot({ status: MembershipStatus.EXPIRED, endsOn: d('2026-08-16') }),
        }),
        d('2026-08-18'),
        CFG,
      ).verdict,
    ).toBe(AccessVerdict.ALLOWED_IN_GRACE);
    expect(accessVerdict(subject({ membership: null }), d('2026-08-18'), CFG).verdict).toBeNull();
  });

  it('composes the grace sentence with both numbers the desk needs', () => {
    const result = accessVerdict(
      subject({
        membership: snapshot({
          status: MembershipStatus.EXPIRED,
          endsOn: d('2026-08-16'),
          graceAdmissionsThisTerm: 2,
        }),
      }),
      d('2026-08-18'),
      CFG,
    );
    expect(result.message).toBe(
      'Ended 16 Aug. Grace — 1 of 3 admissions left, 1 day remaining. Let them in and collect the renewal.',
    );
    expect(result.graceDaysRemaining).toBe(1);
    expect(result.relevantDate).toBe('2026-08-16');
  });

  it('names the plan and the date on a plain active admission', () => {
    expect(accessVerdict(subject(), d('2026-08-14'), CFG).message).toBe(
      'Monthly — active until 28 Aug (14 days left). Let them in.',
    );
  });
});

describe('accessVerdict — boundaries', () => {
  const m = snapshot({ endsOn: d('2026-08-31') });

  it.each([
    ['2026-08-30', 'ALLOW', 'MEMBERSHIP_EXPIRING_SOON'],
    ['2026-08-31', 'ALLOW', 'MEMBERSHIP_EXPIRES_TODAY'],
    ['2026-09-01', 'GRACE', 'MEMBERSHIP_IN_GRACE'],
  ])('endsOn boundary triple: %s is %s', (today, decision, reason) => {
    const result = accessVerdict(subject({ membership: m }), d(today), CFG);
    expect(result.decision).toBe(decision);
    expect(result.allowReason).toBe(reason);
  });

  it.each([
    ['2026-09-02', 'GRACE'],
    ['2026-09-03', 'GRACE'],
    ['2026-09-04', 'DENY'],
  ])('grace-end boundary: %s is %s', (today, decision) => {
    expect(accessVerdict(subject({ membership: m }), d(today), CFG).decision).toBe(decision);
  });

  it('23:59 and 00:01 Manila on the expiry date both read MEMBERSHIP_EXPIRES_TODAY', () => {
    // The regression test for the UTC date-bucketing bug, and the reason
    // gymToday takes an injected `now`.
    const lateEvening = gymToday(new Date('2026-08-31T15:59:00Z'), MANILA);
    const justAfterMidnight = gymToday(new Date('2026-08-30T16:01:00Z'), MANILA);
    expect(lateEvening).toBe('2026-08-31');
    expect(justAfterMidnight).toBe('2026-08-31');
    for (const today of [lateEvening, justAfterMidnight]) {
      expect(accessVerdict(subject({ membership: m }), today, CFG).allowReason).toBe(
        'MEMBERSHIP_EXPIRES_TODAY',
      );
    }
  });
});

describe('accessVerdict — the two self-heals', () => {
  it('FROZEN whose hold ended yesterday admits as ACTIVE', () => {
    // Exact, not approximate: the extension was applied when the hold started,
    // so nothing is being guessed at.
    const result = accessVerdict(
      subject({
        membership: snapshot({
          status: MembershipStatus.FROZEN,
          endsOn: d('2026-09-30'),
          hold: { startsOn: d('2026-08-01'), endsOn: d('2026-08-17') },
        }),
      }),
      d('2026-08-18'),
      CFG,
    );
    expect(result.decision).toBe('ALLOW');
    expect(result.allowReason).toBe('MEMBERSHIP_ACTIVE');
  });

  it('ACTIVE under notice whose term ended denies as CANCELLED', () => {
    const result = accessVerdict(
      subject({
        membership: snapshot({
          status: MembershipStatus.ACTIVE,
          endsOn: d('2026-08-17'),
          cancelRequestedOn: d('2026-08-01'),
        }),
      }),
      d('2026-08-18'),
      CFG,
    );
    expect(result.decision).toBe('DENY');
    expect(result.denialReason).toBe(DenialReason.MEMBERSHIP_CANCELLED);
  });

  it('does NOT honour a SCHEDULED hold the job has not activated', () => {
    // Deliberately not self-healed: denying on a stale schedule while the
    // day-credit has not been applied would be actively unfair.
    const result = accessVerdict(
      subject({ membership: snapshot({ status: MembershipStatus.ACTIVE, hold: null }) }),
      d('2026-08-18'),
      CFG,
    );
    expect(result.decision).toBe('ALLOW');
  });
});

/**
 * Exported for booking-eligibility.ts, which asks it about a CLASS day. These
 * pin that it answers for whatever day it is given, and heals only its two
 * cases — a booking must not inherit a third self-heal by accident.
 */
describe('effectiveStatus — the two self-heals, on any gym day', () => {
  const frozen = snapshot({
    status: MembershipStatus.FROZEN,
    endsOn: d('2026-09-30'),
    hold: { startsOn: d('2026-08-01'), endsOn: d('2026-08-17') },
  });

  it("FROZEN reads FROZEN through the hold's last day, and ACTIVE the day after", () => {
    expect(effectiveStatus(frozen, d('2026-08-17'))).toBe(MembershipStatus.FROZEN);
    expect(effectiveStatus(frozen, d('2026-08-18'))).toBe(MembershipStatus.ACTIVE);
    expect(effectiveStatus(frozen, d('2026-09-25'))).toBe(MembershipStatus.ACTIVE);
  });

  it('FROZEN with no hold row stays FROZEN — nothing says when it thaws', () => {
    expect(effectiveStatus({ ...frozen, hold: null }, d('2026-12-01'))).toBe(
      MembershipStatus.FROZEN,
    );
  });

  it('ACTIVE under notice reads CANCELLED only once endsOn has passed', () => {
    const leaving = snapshot({ endsOn: d('2026-08-31'), cancelRequestedOn: d('2026-08-10') });
    expect(effectiveStatus(leaving, d('2026-08-31'))).toBe(MembershipStatus.ACTIVE);
    expect(effectiveStatus(leaving, d('2026-09-01'))).toBe(MembershipStatus.CANCELLED);
  });

  it('ACTIVE without notice past endsOn stays ACTIVE: lapsing is a ladder step, not a heal', () => {
    expect(effectiveStatus(snapshot({ endsOn: d('2026-08-31') }), d('2026-09-10'))).toBe(
      MembershipStatus.ACTIVE,
    );
  });

  it.each([MembershipStatus.EXPIRED, MembershipStatus.CANCELLED])(
    '%s is never revived by a date, even with endsOn ahead',
    (status) => {
      expect(effectiveStatus(snapshot({ status, endsOn: d('2026-12-31') }), d('2026-08-14'))).toBe(
        status,
      );
    },
  );
});

describe('accessVerdict — precedence', () => {
  it('the account gate beats a valid day pass', () => {
    const result = accessVerdict(
      subject({ userStatus: 'SUSPENDED', membership: null, dayPassValidToday: true }),
      d('2026-08-18'),
      CFG,
    );
    expect(result.decision).toBe('DENY');
    expect(result.denialReason).toBe(DenialReason.ACCOUNT_SUSPENDED);
    expect(result.offer).toBe('MANAGER');
  });

  it('a deactivated account is refused too', () => {
    expect(
      accessVerdict(subject({ userStatus: 'DEACTIVATED' }), d('2026-08-18'), CFG).denialReason,
    ).toBe(DenialReason.ACCOUNT_DEACTIVATED);
  });

  it.each([MembershipStatus.FROZEN, MembershipStatus.CANCELLED, MembershipStatus.EXPIRED])(
    "today's day pass beats a %s membership",
    (status) => {
      const result = accessVerdict(
        subject({
          membership: snapshot({
            status,
            endsOn: d('2026-07-01'),
            hold:
              status === MembershipStatus.FROZEN
                ? { startsOn: d('2026-08-01'), endsOn: d('2026-10-01') }
                : null,
          }),
          dayPassValidToday: true,
        }),
        d('2026-08-18'),
        CFG,
      );
      expect(result.decision).toBe('ALLOW');
      expect(result.allowReason).toBe('DAY_PASS_VALID');
    },
  );

  it('an active membership is reported as such even when a day pass exists', () => {
    const result = accessVerdict(subject({ dayPassValidToday: true }), d('2026-08-14'), CFG);
    expect(result.allowReason).toBe('MEMBERSHIP_ACTIVE');
  });
});

describe('accessVerdict — grace is finite', () => {
  const inGrace = (used: number): MembershipSnapshot =>
    snapshot({
      status: MembershipStatus.EXPIRED,
      endsOn: d('2026-08-16'),
      graceAdmissionsThisTerm: used,
    });

  it('admits while admissions remain', () => {
    expect(accessVerdict(subject({ membership: inGrace(2) }), d('2026-08-18'), CFG).decision).toBe(
      'GRACE',
    );
  });

  it('refuses once the term has used its allowance, inside the window', () => {
    const result = accessVerdict(subject({ membership: inGrace(3) }), d('2026-08-18'), CFG);
    expect(result.decision).toBe('DENY');
    expect(result.denialReason).toBe(DenialReason.MEMBERSHIP_EXPIRED);
    expect(result.offer).toBe('RENEW');
  });

  it('never grants grace to a membership under notice', () => {
    const result = accessVerdict(
      subject({
        membership: snapshot({ endsOn: d('2026-08-16'), cancelRequestedOn: d('2026-08-01') }),
      }),
      d('2026-08-18'),
      CFG,
    );
    expect(result.decision).toBe('DENY');
    expect(result.denialReason).toBe(DenialReason.MEMBERSHIP_CANCELLED);
  });
});

describe('accessVerdict — result invariants', () => {
  it('daysRemaining is never negative and is null with no term', () => {
    expect(
      accessVerdict(
        subject({
          membership: snapshot({ status: MembershipStatus.EXPIRED, endsOn: d('2026-07-01') }),
        }),
        d('2026-08-18'),
        CFG,
      ).daysRemaining,
    ).toBe(0);
    expect(
      accessVerdict(subject({ membership: null }), d('2026-08-18'), CFG).daysRemaining,
    ).toBeNull();
  });

  it('graceDaysRemaining is 0 for every non-grace result', () => {
    const results = [
      accessVerdict(subject(), d('2026-08-14'), CFG),
      accessVerdict(subject({ membership: null }), d('2026-08-18'), CFG),
      accessVerdict(subject({ userStatus: 'SUSPENDED' }), d('2026-08-18'), CFG),
      accessVerdict(
        subject({
          membership: snapshot({ status: MembershipStatus.CANCELLED, endsOn: d('2026-08-03') }),
        }),
        d('2026-08-18'),
        CFG,
      ),
    ];
    for (const result of results) expect(result.graceDaysRemaining).toBe(0);
  });

  it('never mutates its subject', () => {
    const subj = subject();
    const before = JSON.stringify(subj);
    accessVerdict(subj, d('2026-08-14'), CFG);
    expect(JSON.stringify(subj)).toBe(before);
  });

  it('carries no formatted currency string in the message', () => {
    // The desk composes the peso figure client-side from planPriceCentavos.
    // No response body anywhere carries a formatted currency string.
    const all = [
      accessVerdict(subject(), d('2026-08-14'), CFG),
      accessVerdict(subject({ membership: null }), d('2026-08-18'), CFG),
      accessVerdict(
        subject({
          membership: snapshot({ status: MembershipStatus.EXPIRED, endsOn: d('2026-08-16') }),
        }),
        d('2026-08-18'),
        CFG,
      ),
    ];
    for (const result of all) expect(result.message).not.toMatch(/₱|PHP|\d+\.\d{2}/);
  });
});

describe('access-verdict.ts stays pure', () => {
  const source = readFileSync(join(__dirname, 'access-verdict.ts'), 'utf8');

  it('reads no clock', () => {
    expect(source).not.toMatch(/new Date\(/);
    expect(source).not.toMatch(/Date\.now\(/);
  });

  it('reads no config service and no Prisma client at runtime', () => {
    expect(source).not.toMatch(/GymConfigService/);
    expect(source).not.toMatch(/PrismaService/);
    expect(source.match(/^import .*'@prisma\/client';$/gm) ?? []).toEqual([
      "import type { UserStatus } from '@prisma/client';",
    ]);
  });

  it('is not a Nest provider', () => {
    expect(source).not.toMatch(/@Injectable/);
  });
});
