import { HttpStatus } from '@nestjs/common';
import { MembershipStatus } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import {
  TRANSITIONS,
  TRANSITION_BYPASS_REASON_REQUIRED,
  assertTransition,
  isTransitionAllowed,
} from './membership-transitions';

const { ACTIVE, EXPIRED, FROZEN, CANCELLED } = MembershipStatus;

/** Every (from, to) pair §5.5.2's seventeen rows actually produce. */
const ALLOWED: ReadonlyArray<[MembershipStatus | null, MembershipStatus, string]> = [
  [null, ACTIVE, 'rows 1 and 2 — first paid term, and the legacy import'],
  [ACTIVE, ACTIVE, 'rows 3, 5, 6, 16 — renewal before expiry, notice, withdrawal, comp days'],
  [ACTIVE, FROZEN, 'row 7 — hold starts'],
  [ACTIVE, EXPIRED, 'row 11 — nightly, endsOn passed with no notice'],
  [ACTIVE, CANCELLED, 'rows 12 and 13 — notice ran out, or an admin terminates'],
  [EXPIRED, ACTIVE, 'rows 4 and 14 — renewal in grace, reactivation past grace'],
  [EXPIRED, EXPIRED, 'row 16 — comp days on an expired member'],
  [EXPIRED, CANCELLED, 'row 13 — admin terminates'],
  [FROZEN, ACTIVE, 'rows 8 and 9 — hold completed, or released early'],
  [FROZEN, FROZEN, 'row 16 — comp days while frozen'],
  [FROZEN, CANCELLED, 'row 10 — admin terminates during a freeze'],
  [CANCELLED, ACTIVE, 'row 15 — reactivation'],
];

/** The complement. Every one of these is a 422, never a silent no-op. */
const REJECTED: ReadonlyArray<[MembershipStatus | null, MembershipStatus, string]> = [
  [null, EXPIRED, 'a membership is never created already expired'],
  [null, FROZEN, 'a membership is never created already frozen'],
  [null, CANCELLED, 'a membership is never created already cancelled'],
  [EXPIRED, FROZEN, '§5.5.3 — you cannot pause a term you have not paid for'],
  [CANCELLED, FROZEN, '§5.5.3 — same, after termination'],
  [FROZEN, EXPIRED, 'the nightly expiry step excludes FROZEN deliberately'],
  [CANCELLED, EXPIRED, 'a cancelled membership has no term left to elapse'],
  [CANCELLED, CANCELLED, 'already cancelled — nothing to terminate'],
];

function domainErrorFrom(from: MembershipStatus | null, to: MembershipStatus): DomainException {
  try {
    assertTransition(from, to);
  } catch (error) {
    if (error instanceof DomainException) return error;
    throw error;
  }
  throw new Error(`assertTransition(${String(from)}, ${to}) did not throw`);
}

describe('isTransitionAllowed', () => {
  it.each(ALLOWED)('allows %s → %s (%s)', (from, to) => {
    expect(isTransitionAllowed(from, to)).toBe(true);
  });

  it.each(REJECTED)('refuses %s → %s (%s)', (from, to) => {
    expect(isTransitionAllowed(from, to)).toBe(false);
  });

  it('covers every (from, to) pair exactly once across the two tables', () => {
    const froms: Array<MembershipStatus | null> = [null, ACTIVE, EXPIRED, FROZEN, CANCELLED];
    const tos = [ACTIVE, EXPIRED, FROZEN, CANCELLED];
    const listed = new Set([...ALLOWED, ...REJECTED].map(([from, to]) => `${String(from)}->${to}`));
    expect(listed.size).toBe(froms.length * tos.length);
    for (const from of froms) {
      for (const to of tos) {
        expect(listed.has(`${String(from)}->${to}`)).toBe(true);
      }
    }
  });
});

describe('assertTransition', () => {
  it.each(ALLOWED)('does not throw for %s → %s', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each(REJECTED)('throws MEMBERSHIP_INVALID_TRANSITION at 422 for %s → %s', (from, to) => {
    const error = domainErrorFrom(from, to);
    expect(error.code).toBe('MEMBERSHIP_INVALID_TRANSITION');
    expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });

  it('names both states in the message, so the desk log is readable', () => {
    expect(domainErrorFrom(EXPIRED, FROZEN).message).toContain('EXPIRED');
    expect(domainErrorFrom(EXPIRED, FROZEN).message).toContain('FROZEN');
  });

  it('names the creation edge rather than printing null', () => {
    expect(domainErrorFrom(null, FROZEN).message).toMatch(/new membership|creation/i);
  });
});

describe('TRANSITIONS', () => {
  it('is keyed by every MembershipStatus, and only those four', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual(Object.values(MembershipStatus).sort());
  });

  it('lets a cancelled membership go only to ACTIVE', () => {
    expect([...TRANSITIONS[CANCELLED]]).toEqual([ACTIVE]);
  });
});

describe('what this table deliberately does NOT refuse', () => {
  // Four of §5.5.3's seven rows are not status pairs. Written down here so the
  // next author looks in the right file rather than "fixing" the table.
  it('allows FROZEN → ACTIVE, because row 9 needs it — the renewal refusal is elsewhere', () => {
    // Renewing a FROZEN membership is 422 MEMBERSHIP_NOT_ACTIVE in
    // MembershipSalesService, so the extension arithmetic never has two writers.
    expect(isTransitionAllowed(FROZEN, ACTIVE)).toBe(true);
  });

  it('allows FROZEN → FROZEN, because row 16 needs it — the second freeze is refused by the sentinel', () => {
    // A second running hold is structurally impossible:
    // MembershipHold.activeMembershipId is nullable-unique.
    expect(isTransitionAllowed(FROZEN, FROZEN)).toBe(true);
  });

  it('allows CANCELLED → ACTIVE, because row 15 is reactivation, not notice', () => {
    // Giving notice on a CANCELLED membership is refused by
    // MembershipLifecycleService: there is nothing left to give notice on.
    expect(isTransitionAllowed(CANCELLED, ACTIVE)).toBe(true);
  });

  it('documents that membership.status.correct is the only permitted bypass', () => {
    expect(TRANSITION_BYPASS_REASON_REQUIRED).toBe(true);
  });
});
