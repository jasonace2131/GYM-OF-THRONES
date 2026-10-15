import { describe, expect, it } from 'vitest';
import type { StaffInvitationView } from '@got/shared';
import {
  invitationActions,
  invitationBadge,
  invitationTimeline,
  splitInvitations,
} from './invitations';

const NOW = new Date('2026-09-25T04:00:00.000Z');

function inv(overrides: Partial<StaffInvitationView> = {}): StaffInvitationView {
  return {
    id: 'i1',
    email: 'ana@example.com',
    role: 'COACH',
    status: 'PENDING',
    invitedBy: { id: 'a1', name: 'Maria Santos' },
    createdAt: '2026-09-24T04:00:00.000Z',
    expiresAt: '2026-10-01T04:00:00.000Z',
    acceptedAt: null,
    acceptedBy: null,
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

describe('invitationBadge', () => {
  it('names every status in plain words, with a tone that means one thing', () => {
    expect(invitationBadge('PENDING')).toEqual({ label: 'Pending', tone: 'warn' });
    expect(invitationBadge('EXPIRED')).toEqual({ label: 'Expired', tone: 'neutral' });
    expect(invitationBadge('ACCEPTED')).toEqual({ label: 'Accepted', tone: 'ok' });
    expect(invitationBadge('REVOKED')).toEqual({ label: 'Withdrawn', tone: 'neutral' });
  });
});

describe('invitationActions', () => {
  it('offers an ADMIN resend and withdraw on a pending coach invitation', () => {
    expect(invitationActions(inv(), 'ADMIN')).toEqual({ resend: true, revoke: true });
  });

  it('still offers both on an expired one — resending is the usual fix', () => {
    expect(invitationActions(inv({ status: 'EXPIRED' }), 'ADMIN')).toEqual({
      resend: true,
      revoke: true,
    });
  });

  it("offers an ADMIN nothing on the Super Admin's ADMIN invitation", () => {
    expect(invitationActions(inv({ role: 'ADMIN' }), 'ADMIN')).toEqual({
      resend: false,
      revoke: false,
    });
    expect(invitationActions(inv({ role: 'ADMIN' }), 'DEV')).toEqual({
      resend: true,
      revoke: true,
    });
  });

  it('offers nothing on an accepted or withdrawn invitation', () => {
    expect(invitationActions(inv({ status: 'ACCEPTED' }), 'DEV')).toEqual({
      resend: false,
      revoke: false,
    });
    expect(invitationActions(inv({ status: 'REVOKED' }), 'DEV')).toEqual({
      resend: false,
      revoke: false,
    });
  });
});

describe('invitationTimeline', () => {
  it('counts down a pending invitation in whole days', () => {
    expect(invitationTimeline(inv(), NOW)).toBe('Expires in 6 days');
  });

  it('says "today" rather than "in 0 days"', () => {
    expect(invitationTimeline(inv({ expiresAt: '2026-09-25T10:00:00.000Z' }), NOW)).toBe(
      'Expires today',
    );
  });

  it('names who took it up, or who withdrew it', () => {
    expect(
      invitationTimeline(
        inv({
          status: 'ACCEPTED',
          acceptedAt: '2026-09-24T09:00:00.000Z',
          acceptedBy: { id: 'u1', name: 'Ana Cruz' },
        }),
        NOW,
      ),
    ).toBe('Accepted by Ana Cruz');
    expect(
      invitationTimeline(
        inv({
          status: 'REVOKED',
          revokedAt: '2026-09-24T09:00:00.000Z',
          revokedBy: { id: 'a1', name: 'Maria Santos' },
        }),
        NOW,
      ),
    ).toBe('Withdrawn by Maria Santos');
  });

  it('says an expired invitation expired', () => {
    expect(
      invitationTimeline(inv({ status: 'EXPIRED', expiresAt: '2026-09-20T04:00:00.000Z' }), NOW),
    ).toBe('Expired — resend to give them a new link');
  });
});

describe('splitInvitations', () => {
  it('puts open invitations first and keeps the rest as recent history', () => {
    const { open, recent } = splitInvitations([
      inv({ id: 'a', status: 'ACCEPTED' }),
      inv({ id: 'b', status: 'PENDING' }),
      inv({ id: 'c', status: 'EXPIRED' }),
      inv({ id: 'd', status: 'REVOKED' }),
    ]);
    expect(open.map((i) => i.id)).toEqual(['b', 'c']);
    expect(recent.map((i) => i.id)).toEqual(['a', 'd']);
  });
});
