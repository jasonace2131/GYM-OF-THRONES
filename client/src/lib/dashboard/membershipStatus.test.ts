import { describe, expect, it } from 'vitest';
import { DenialReason, MembershipStatus, type AllowReason } from '@got/shared';
import type { AccessResult, MembershipDetail } from '@/lib/portalData';
import { membershipStatusView, withoutSelfService } from './membershipStatus';

const PLAN = {
  id: 'm1',
  planCode: 'MONTHLY',
  planName: 'Monthly',
  planPriceCentavos: 80000,
  termMonths: 1,
  status: MembershipStatus.ACTIVE,
  startsOn: '2026-09-04',
  endsOn: '2026-10-04',
  graceDays: 3,
  cancelRequestedOn: null,
  guestPassesRemaining: 0,
} as unknown as Omit<MembershipDetail, 'verdict'>;

/** Overrides with plain-string dates — the fixtures are cast, not branded. */
type Loose<T> = { [K in keyof T]?: unknown };

function allow(allowReason: AllowReason, over: Loose<AccessResult> = {}): AccessResult {
  return {
    decision: allowReason === 'MEMBERSHIP_IN_GRACE' ? 'GRACE' : 'ALLOW',
    verdict: null,
    allowReason,
    denialReason: null,
    // Desk copy. The member must NEVER be shown it.
    message: 'Monthly — active until 4 Oct (10 days left). Let them in.',
    relevantDate: '2026-10-04',
    daysRemaining: 10,
    graceDaysRemaining: 0,
    offer: 'NONE',
    ...over,
  } as AccessResult;
}

function deny(denialReason: DenialReason, over: Loose<AccessResult> = {}): AccessResult {
  return {
    decision: 'DENY',
    verdict: null,
    allowReason: null,
    denialReason,
    message: 'Do not let them in — get a manager.',
    relevantDate: null,
    daysRemaining: null,
    graceDaysRemaining: 0,
    offer: 'RENEW',
    ...over,
  } as AccessResult;
}

function detail(verdict: AccessResult, over: Partial<MembershipDetail> = {}): MembershipDetail {
  return { ...PLAN, verdict, ...over } as MembershipDetail;
}

const view = (verdict: AccessResult, over: Partial<MembershipDetail> = {}) =>
  membershipStatusView(detail(verdict, over), verdict);

const CHECK_IN = { label: 'Check in', href: '/portal/checkin' };
const BOOK = { label: 'Book a class', href: '/portal/schedule' };
const RENEW = { label: 'Renew', href: '/portal/subscription' };
const CHOOSE = { label: 'Choose a plan', href: '/portal/subscription' };

describe('membershipStatusView — admitted', () => {
  it('ACTIVE: calm, a ring, check in and book', () => {
    expect(view(allow('MEMBERSHIP_ACTIVE'))).toEqual({
      tone: 'ok',
      badge: 'Monthly · Active',
      line: null,
      primaryCta: CHECK_IN,
      secondaryCta: BOOK,
      // 4 Sep – 4 Oct inclusive is 31 days.
      ring: { remaining: 10, total: 31, tone: 'ok' },
      untilLabel: 'Active until 4 Oct',
    });
  });

  /** The threshold is the SERVER's (allowReason), never re-derived from a day count here. */
  it('EXPIRING SOON: amber, keyed on the reason and not on the number', () => {
    const result = view(allow('MEMBERSHIP_EXPIRING_SOON', { daysRemaining: 12 }));
    expect(result.tone).toBe('warn');
    expect(result.badge).toBe('Monthly · Ends soon');
    expect(result.line).toBe(
      'Your plan ends 4 Oct — 12 days left. Renew at the front desk to keep training without a gap.',
    );
    expect(result.primaryCta).toEqual(CHECK_IN);
    expect(result.secondaryCta).toEqual(RENEW);
    expect(result.ring).toEqual({ remaining: 12, total: 31, tone: 'warn' });
    expect(result.untilLabel).toBe('Ends 4 Oct');
  });

  it('EXPIRING SOON: singular day', () => {
    expect(view(allow('MEMBERSHIP_EXPIRING_SOON', { daysRemaining: 1 })).line).toContain(
      '1 day left',
    );
  });

  it('EXPIRES TODAY: last day, no "0 days left" ring', () => {
    const result = view(allow('MEMBERSHIP_EXPIRES_TODAY', { daysRemaining: 0 }));
    expect(result.tone).toBe('warn');
    expect(result.badge).toBe('Monthly · Last day');
    expect(result.line).toBe(
      'Today is the last day of your plan. Renew at the front desk to keep training.',
    );
    expect(result.ring).toBeNull();
    expect(result.untilLabel).toBe('Ends today');
    expect(result.secondaryCta).toEqual(RENEW);
  });

  it('ENDING: a cancellation is quiet, not an alarm', () => {
    const result = view(allow('MEMBERSHIP_ENDING'), {
      cancelRequestedOn: '2026-09-20',
    } as Partial<MembershipDetail>);
    expect(result.tone).toBe('neutral');
    expect(result.badge).toBe('Monthly · Ending');
    expect(result.line).toBe("Your plan won't renew — it ends 4 Oct.");
    expect(result.ring).toEqual({ remaining: 10, total: 31, tone: 'neutral' });
    expect(result.untilLabel).toBe('Ends 4 Oct');
    expect(result.primaryCta).toEqual(CHECK_IN);
  });

  it('GRACE: the door still opens, and the member is told to renew', () => {
    const verdict = allow('MEMBERSHIP_IN_GRACE', {
      relevantDate: '2026-09-22',
      daysRemaining: 0,
      graceDaysRemaining: 2,
      offer: 'RENEW',
    });
    const result = view(verdict, { endsOn: '2026-09-22' } as Partial<MembershipDetail>);
    expect(result.tone).toBe('warn');
    expect(result.badge).toBe('Monthly · Grace period');
    expect(result.line).toBe(
      "Your plan ended 22 Sep. You're in a grace period for 2 more days — renew at the front desk to keep training.",
    );
    expect(result.primaryCta).toEqual(CHECK_IN);
    expect(result.secondaryCta).toEqual(RENEW);
    expect(result.ring).toBeNull();
    expect(result.untilLabel).toBe('Ended 22 Sep');
  });

  it('GRACE: the last grace day says so', () => {
    const verdict = allow('MEMBERSHIP_IN_GRACE', {
      relevantDate: '2026-09-22',
      graceDaysRemaining: 0,
    });
    expect(view(verdict, { endsOn: '2026-09-22' } as Partial<MembershipDetail>).line).toBe(
      'Your plan ended 22 Sep, and today is the last day of your grace period — renew at the front desk to keep training.',
    );
  });

  it('DAY PASS: valid today, with a nudge towards a plan', () => {
    const verdict = allow('DAY_PASS_VALID', { relevantDate: '2026-09-24', daysRemaining: null });
    const result = membershipStatusView(null, verdict);
    expect(result).toEqual({
      tone: 'ok',
      badge: 'Day pass · Today',
      line: 'Your day pass is valid until closing today.',
      primaryCta: CHECK_IN,
      secondaryCta: CHOOSE,
      ring: null,
      untilLabel: null,
    });
  });
});

describe('membershipStatusView — refused', () => {
  it('NO_MEMBERSHIP: "No active plan", choose one, no ring and no Check in', () => {
    const result = membershipStatusView(null, deny(DenialReason.NO_MEMBERSHIP));
    expect(result).toEqual({
      tone: 'neutral',
      badge: 'No active plan',
      line: 'No plan on file yet. The desk can set you up, or sell you today.',
      primaryCta: CHOOSE,
      secondaryCta: null,
      ring: null,
      untilLabel: null,
    });
  });

  it('EXPIRED: red, the member copy with the date, renew', () => {
    const verdict = deny(DenialReason.MEMBERSHIP_EXPIRED, { relevantDate: '2026-09-20' });
    const result = view(verdict, {
      endsOn: '2026-09-20',
      status: MembershipStatus.EXPIRED,
    } as Partial<MembershipDetail>);
    expect(result.tone).toBe('danger');
    expect(result.badge).toBe('Monthly · Expired');
    expect(result.line).toBe('Your plan ended 20 Sep. The desk can renew you, or sell you today.');
    expect(result.primaryCta).toEqual(RENEW);
    expect(result.secondaryCta).toBeNull();
    expect(result.ring).toBeNull();
    expect(result.untilLabel).toBe('Ended 20 Sep');
  });

  it('FROZEN: paused until the hold ends', () => {
    const verdict = deny(DenialReason.MEMBERSHIP_FROZEN, {
      relevantDate: '2026-10-15',
      offer: 'OVERRIDE',
    });
    const result = view(verdict, { status: MembershipStatus.FROZEN } as Partial<MembershipDetail>);
    expect(result.tone).toBe('neutral');
    expect(result.badge).toBe('Monthly · Paused');
    expect(result.line).toBe(
      'Your plan is paused until 15 Oct. The desk can unpause it, or sell you today.',
    );
    expect(result.primaryCta).toEqual({ label: 'View my plan', href: '/portal/subscription' });
    expect(result.untilLabel).toBe('Paused until 15 Oct');
  });

  it('CANCELLED: ended, start a new one', () => {
    const verdict = deny(DenialReason.MEMBERSHIP_CANCELLED, { relevantDate: '2026-09-01' });
    const result = view(verdict, {
      status: MembershipStatus.CANCELLED,
    } as Partial<MembershipDetail>);
    expect(result.badge).toBe('Monthly · Ended');
    expect(result.line).toBe('Your plan ended 1 Sep. The desk can start a new one.');
    expect(result.primaryCta).toEqual(CHOOSE);
  });

  /**
   * VAGUE, and only vague. Why an account is suspended is between the member
   * and management; the phone says "talk to the desk" and nothing else — no
   * plan, no reason, no date, and never the desk's own message.
   */
  it.each([DenialReason.ACCOUNT_SUSPENDED, DenialReason.ACCOUNT_DEACTIVATED])(
    '%s: vague copy only',
    (reason) => {
      const result = view(
        deny(reason, { message: 'This account is suspended. Do not let them in — get a manager.' }),
      );
      expect(result).toEqual({
        tone: 'neutral',
        badge: 'See the front desk',
        line: "There's a note on your account. Please talk to the desk.",
        primaryCta: null,
        secondaryCta: null,
        ring: null,
        untilLabel: null,
      });
      expect(JSON.stringify(result)).not.toMatch(/suspend|deactivat|Monthly|manager/i);
    },
  );

  it('never shows the desk message for any reason', () => {
    for (const reason of Object.values(DenialReason)) {
      const result = view(deny(reason, { message: 'DESK-ONLY', relevantDate: '2026-09-20' }));
      expect(JSON.stringify(result)).not.toContain('DESK-ONLY');
    }
  });

  /**
   * My Subscription renders `line` where it used to render `verdict.message`
   * verbatim ("… Let them in."), so the admitted states are pinned too.
   */
  it('never shows the desk message for an admitted member either', () => {
    const reasons: AllowReason[] = [
      'MEMBERSHIP_ACTIVE',
      'MEMBERSHIP_EXPIRES_TODAY',
      'MEMBERSHIP_EXPIRING_SOON',
      'MEMBERSHIP_ENDING',
      'MEMBERSHIP_IN_GRACE',
      'DAY_PASS_VALID',
    ];
    for (const reason of reasons) {
      const result = view(allow(reason, { message: 'DESK-ONLY' }));
      expect(JSON.stringify(result)).not.toContain('DESK-ONLY');
    }
  });
});

describe('withoutSelfService — the dashboard for someone who cannot manage a plan', () => {
  const base = {
    tone: 'ok' as const,
    badge: 'Monthly · Active',
    line: null,
    ring: null,
    untilLabel: null,
  };
  const renew = { label: 'Renew', href: '/portal/subscription' };
  const checkIn = { label: 'Check in', href: '/portal/checkin' };

  it('keeps every button for a member who can manage their plan', () => {
    const v = { ...base, primaryCta: renew, secondaryCta: checkIn };
    expect(withoutSelfService(v, true)).toEqual(v);
  });

  /**
   * Coaches and staff lost My Subscription (membership.self is CLIENT-only).
   * A Renew button that leads to "not available for your role" is a dead end.
   */
  it('drops plan-page buttons for a coach or staff member', () => {
    const v = { ...base, primaryCta: renew, secondaryCta: checkIn };
    expect(withoutSelfService(v, false)).toEqual({
      ...base,
      primaryCta: checkIn,
      secondaryCta: null,
    });
  });

  it('leaves no button at all when the only one was the plan page', () => {
    const v = { ...base, primaryCta: renew, secondaryCta: null };
    expect(withoutSelfService(v, false)).toEqual({ ...base, primaryCta: null, secondaryCta: null });
  });
});
