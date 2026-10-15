import { AccessVerdict, DenialReason, MembershipStatus } from '@got/shared';
import type { CheckInOutcome } from '@got/shared';
import { asCivilDate } from '../common/time/gym-time';
import {
  accessVerdict,
  type AccessResult,
  type MembershipSnapshot,
} from '../membership/access-verdict';
import {
  formatDuration,
  nextStepFor,
  presentCheckIn,
  toCheckInMembershipSummary,
  toneFor,
  type CheckInPresentationInput,
} from './check-in.presenter';

const TZ = 'Asia/Manila';
/** 2026-08-20 18:14 Manila. */
const AT = new Date('2026-08-20T10:14:00.000Z');
const CFG = { expiringSoonDays: 7, graceAdmissionsMax: 3 };

function snapshot(overrides: Partial<MembershipSnapshot> = {}): MembershipSnapshot {
  return {
    status: MembershipStatus.ACTIVE,
    startsOn: asCivilDate('2026-08-01'),
    endsOn: asCivilDate('2026-09-16'),
    graceDays: 3,
    graceAdmissionsThisTerm: 0,
    cancelRequestedOn: null,
    planName: 'Monthly',
    planPriceCentavos: 80000,
    hold: null,
    ...overrides,
  };
}

/** Runs the REAL ladder rather than hand-building an AccessResult. */
function verdictFor(
  membership: MembershipSnapshot | null,
  today = '2026-08-20',
  userStatus: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' = 'ACTIVE',
): AccessResult {
  return accessVerdict(
    { userStatus, membership, dayPassValidToday: false },
    asCivilDate(today),
    CFG,
  );
}

function input(overrides: Partial<CheckInPresentationInput> = {}): CheckInPresentationInput {
  const membership = overrides.membership === undefined ? snapshot() : overrides.membership;
  return {
    outcome: 'CHECKED_IN',
    verdict: verdictFor(membership),
    firstName: 'Juan',
    membership,
    occurredAt: AT,
    timeZone: TZ,
    sessionMinutes: null,
    checkOutAvailableAt: null,
    reopenWindowMinutes: 60,
    ...overrides,
  };
}

describe('toneFor', () => {
  it('maps DENIED to SEE_DESK regardless of verdict', () => {
    expect(toneFor('DENIED', null)).toBe('SEE_DESK');
    expect(toneFor('DENIED', verdictFor(snapshot()))).toBe('SEE_DESK');
  });

  it('maps CHECKED_OUT to GOODBYE — leaving must never read as an admission', () => {
    expect(toneFor('CHECKED_OUT', null)).toBe('GOODBYE');
  });

  /**
   * The load-bearing one. A grace admission checked in, so its OUTCOME is
   * CHECKED_IN like any other; only the stored verdict distinguishes it.
   * Deciding tone from the outcome would render a grace entry green and
   * silently drop the collection prompt that is the only reason grace is
   * finite.
   */
  it('decides GRACE from the stored verdict, never from the outcome', () => {
    const grace = verdictFor(snapshot({ endsOn: asCivilDate('2026-08-18') }));
    expect(grace.verdict).toBe(AccessVerdict.ALLOWED_IN_GRACE);

    for (const outcome of ['CHECKED_IN', 'RECHECKED_IN', 'REOPENED'] as CheckInOutcome[]) {
      expect(toneFor(outcome, grace)).toBe('GRACE');
    }
  });

  it('maps every ordinary admission to WELCOME', () => {
    const allowed = verdictFor(snapshot());
    for (const outcome of [
      'CHECKED_IN',
      'RECHECKED_IN',
      'REOPENED',
      'ALREADY_INSIDE',
    ] as CheckInOutcome[]) {
      expect(toneFor(outcome, allowed)).toBe('WELCOME');
    }
  });
});

describe('presentCheckIn — WELCOME', () => {
  it('renders identity and time in the subhead and the plan below it', () => {
    const result = presentCheckIn(input());
    expect(result.display.tone).toBe('WELCOME');
    expect(result.display.headline).toBe("You're in.");
    expect(result.display.subhead).toBe('Juan · 6:14 PM');
    expect(result.display.detail).toBe('Monthly · valid until 16 Sep');
    expect(result.nextStep).toBeNull();
    expect(result.memberMessage).toBeNull();
  });

  it('renders no plan line at all when there is no membership', () => {
    // Reachable through a day pass: admitted, no term.
    const result = presentCheckIn(input({ membership: null }));
    expect(result.display.detail).toBeNull();
  });

  /**
   * ALREADY_INSIDE is the most confusing state in any second-scan design, and
   * the copy does all the work: naming the exact clock time is the whole fix.
   * "Try again later" generates a conversation at the desk every single time.
   */
  it('names the exact clock time a check-out becomes possible on ALREADY_INSIDE', () => {
    const result = presentCheckIn(
      input({
        outcome: 'ALREADY_INSIDE',
        checkOutAvailableAt: new Date('2026-08-20T10:34:00.000Z'),
      }),
    );
    expect(result.display.tone).toBe('WELCOME');
    expect(result.display.headline).toBe("You're already in.");
    expect(result.display.subhead).toBe('Since 6:14 PM.');
    expect(result.display.detail).toBe('Scan again after 6:34 PM to check out.');
  });
});

describe('presentCheckIn — GRACE', () => {
  const graceInput = (): CheckInPresentationInput => {
    const membership = snapshot({ endsOn: asCivilDate('2026-08-18') });
    return input({ membership, verdict: verdictFor(membership) });
  };

  it('says the door opened FIRST, and asks for money second', () => {
    const result = presentCheckIn(graceInput());
    expect(result.display.tone).toBe('GRACE');
    // "Admitted, and it says so first." The headline is not a refusal.
    expect(result.display.headline).toBe("You're in — see desk.");
    expect(result.display.detail).toContain('Your Monthly ended 18 Aug');
    expect(result.display.detail).toContain('settle at the desk');
  });

  it('carries the collection prompt as the next step', () => {
    expect(presentCheckIn(graceInput()).nextStep).toEqual({
      kind: 'RENEW_AT_DESK',
      label: 'Settle at the desk',
    });
  });

  it('never composes a peso figure — §5.4 keeps currency off the wire', () => {
    const result = presentCheckIn(graceInput());
    expect(result.display.detail).not.toMatch(/[₱P]\s?\d/);
    expect(result.staffMessage).not.toMatch(/[₱P]\s?\d/);
  });
});

describe('presentCheckIn — GOODBYE', () => {
  it('renders the session length and the re-entry line, never a green tone', () => {
    const result = presentCheckIn(
      input({ outcome: 'CHECKED_OUT', verdict: null, sessionMinutes: 86 }),
    );
    expect(result.display.tone).toBe('GOODBYE');
    expect(result.display.headline).toBe('Checked out.');
    expect(result.display.subhead).toBe('1 h 26 m today.');
    // §6.6.4: the recovery line has to be on the card that PRECEDES the
    // mistake — and it renders the CONFIGURED window, never a baked-in 20.
    expect(result.display.detail).toBe(
      'Heading back in? Scan again within 60 minutes and it stays one visit.',
    );
  });

  it('renders whatever window the config says, not a constant', () => {
    const result = presentCheckIn(
      input({ outcome: 'CHECKED_OUT', verdict: null, sessionMinutes: 5, reopenWindowMinutes: 20 }),
    );
    expect(result.display.detail).toContain('within 20 minutes');
  });

  it('works with a null verdict — membership is never evaluated on the way out', () => {
    expect(() =>
      presentCheckIn(input({ outcome: 'CHECKED_OUT', verdict: null, sessionMinutes: 0 })),
    ).not.toThrow();
  });
});

describe('presentCheckIn — SEE_DESK', () => {
  const denied = (
    membership: MembershipSnapshot | null,
    userStatus: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
  ): ReturnType<typeof presentCheckIn> =>
    presentCheckIn(
      input({
        outcome: 'DENIED',
        membership,
        verdict: verdictFor(membership, '2026-08-20', userStatus),
      }),
    );

  it('uses one neutral headline for every reason', () => {
    const expired = denied(snapshot({ endsOn: asCivilDate('2026-07-01') }));
    const none = denied(null);
    const suspended = denied(snapshot(), 'SUSPENDED');

    for (const result of [expired, none, suspended]) {
      expect(result.display.tone).toBe('SEE_DESK');
      expect(result.display.headline).toBe('Not checked in yet.');
    }
  });

  /**
   * The single most important assertion in this file. A member is in public
   * and has just been refused by a machine; the words below are what
   * humiliates someone in a queue, and they remember it far longer than they
   * remember the gym.
   */
  it('never uses machine vocabulary on the member surface', () => {
    const banned = /DENIED|REJECTED|INVALID|FAILED|UNAUTHORIZED|ACCESS DENIED|EXPIRED MEMBER/i;
    for (const result of [
      denied(snapshot({ endsOn: asCivilDate('2026-07-01') })),
      denied(
        snapshot({
          status: MembershipStatus.CANCELLED,
          cancelRequestedOn: asCivilDate('2026-07-01'),
          endsOn: asCivilDate('2026-07-31'),
        }),
      ),
      denied(null),
      denied(snapshot(), 'SUSPENDED'),
    ]) {
      expect(result.display.headline).not.toMatch(banned);
      expect(result.display.subhead).not.toMatch(banned);
      expect(result.display.detail ?? '').not.toMatch(banned);
      expect(result.memberMessage ?? '').not.toMatch(banned);
    }
  });

  /**
   * Why an account was suspended is between the member and management.
   * Rendering "SUSPENDED — NON-PAYMENT" on a phone in a queue is precisely the
   * humiliation §9.5 exists to prevent — and the staff message two feet away
   * carries the real thing, which is the correct channel.
   */
  it('is vague about a suspended account on the phone and blunt about it to the desk', () => {
    const result = denied(snapshot(), 'SUSPENDED');
    expect(result.memberMessage).toBe("There's a note on your account. Please talk to the desk.");
    expect(result.display.detail).toBe(result.memberMessage);
    expect(result.staffMessage).toContain('Do not let them in');
    expect(result.staffMessage).not.toBe(result.memberMessage);
  });

  it('enriches a membership denial with the date the member already knows', () => {
    const result = denied(snapshot({ endsOn: asCivilDate('2026-07-01') }));
    expect(result.memberMessage).toBe(
      'Your plan ended 1 Jul. The desk can renew you, or sell you today.',
    );
  });

  it('routes each reason to the right counter action', () => {
    expect(nextStepFor(DenialReason.NO_MEMBERSHIP).kind).toBe('WALK_IN_AT_DESK');
    expect(nextStepFor(DenialReason.MEMBERSHIP_EXPIRED).kind).toBe('RENEW_AT_DESK');
    expect(nextStepFor(DenialReason.MEMBERSHIP_CANCELLED).kind).toBe('RENEW_AT_DESK');
    expect(nextStepFor(DenialReason.MEMBERSHIP_FROZEN).kind).toBe('SEE_DESK');
    expect(nextStepFor(DenialReason.ACCOUNT_SUSPENDED).kind).toBe('SEE_DESK');
    expect(nextStepFor(DenialReason.CHECKIN_DAILY_LIMIT).kind).toBe('SEE_DESK');
  });

  it('never offers a price the member can pay in-app', () => {
    for (const reason of Object.values(DenialReason)) {
      expect(nextStepFor(reason).label).not.toMatch(/[₱P]\s?\d/);
    }
  });
});

describe('toCheckInMembershipSummary', () => {
  it('projects the term and the live decision', () => {
    const membership = snapshot();
    const summary = toCheckInMembershipSummary(membership, verdictFor(membership));
    expect(summary).toEqual({
      planName: 'Monthly',
      status: MembershipStatus.ACTIVE,
      endsOn: '2026-09-16',
      daysRemaining: 27,
      decision: 'ALLOW',
    });
  });

  it('is renderable with no membership at all — never a 404 state', () => {
    expect(toCheckInMembershipSummary(null, verdictFor(null))).toEqual({
      planName: null,
      status: null,
      endsOn: null,
      daysRemaining: null,
      decision: 'DENY',
    });
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0 m'],
    [1, '1 m'],
    [59, '59 m'],
    [60, '1 h 0 m'],
    [86, '1 h 26 m'],
    [1440, '24 h 0 m'],
  ])('renders %i minutes as %s', (minutes, expected) => {
    expect(formatDuration(minutes)).toBe(expected);
  });

  it('clamps a negative duration rather than rendering one', () => {
    expect(formatDuration(-5)).toBe('0 m');
  });
});
