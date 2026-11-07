import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MembershipStatus } from '@got/shared';
import { StandingBadge } from './ui';
import { membershipActions } from '@/lib/membershipActions';

/**
 * The member drawer (owner bug report, 2026-11-07): its badge said EXPIRED
 * for a frozen plan and for a cancelled one, and it still offered Freeze and
 * Cancel on a plan already cancelled, both of which can only fail.
 */
const badge = (props: Parameters<typeof StandingBadge>[0]): string =>
  renderToStaticMarkup(<StandingBadge {...props} />).replace(/<[^>]+>/g, '');

describe('StandingBadge', () => {
  const denied = { decision: 'DENY' as const, daysRemaining: 0, hasMembership: true };

  it('names a refused plan by why it is refused', () => {
    expect(badge({ ...denied, denialReason: 'MEMBERSHIP_FROZEN' })).toBe('Frozen');
    expect(badge({ ...denied, denialReason: 'MEMBERSHIP_CANCELLED' })).toBe('Cancelled');
    expect(badge({ ...denied, denialReason: 'MEMBERSHIP_EXPIRED' })).toBe('Expired');
    expect(badge({ ...denied, denialReason: 'ACCOUNT_SUSPENDED' })).toBe('Suspended');
    expect(badge({ ...denied, denialReason: 'ACCOUNT_DEACTIVATED' })).toBe('Deactivated');
  });

  it('still reads Expired for a refusal with no reason given, as before', () => {
    expect(badge(denied)).toBe('Expired');
  });

  it('is unchanged for plans that let the member in', () => {
    expect(badge({ decision: 'ALLOW', daysRemaining: 20, hasMembership: true })).toBe('Active');
    expect(badge({ decision: 'ALLOW', daysRemaining: 5, hasMembership: true })).toBe('Expiring');
    expect(badge({ decision: 'GRACE', daysRemaining: 0, hasMembership: true })).toBe('In grace');
    expect(badge({ decision: 'DENY', daysRemaining: null, hasMembership: false })).toBe('No plan');
  });
});

describe('membershipActions', () => {
  it('offers Freeze only on an active plan, as the server allows', () => {
    expect(membershipActions(MembershipStatus.ACTIVE).freeze).toBe(true);
    expect(membershipActions(MembershipStatus.FROZEN).freeze).toBe(false);
    expect(membershipActions(MembershipStatus.EXPIRED).freeze).toBe(false);
    expect(membershipActions(MembershipStatus.CANCELLED).freeze).toBe(false);
  });

  it('offers Cancel on anything not already cancelled', () => {
    expect(membershipActions(MembershipStatus.ACTIVE).cancel).toBe(true);
    expect(membershipActions(MembershipStatus.FROZEN).cancel).toBe(true);
    expect(membershipActions(MembershipStatus.EXPIRED).cancel).toBe(true);
    expect(membershipActions(MembershipStatus.CANCELLED).cancel).toBe(false);
  });
});
