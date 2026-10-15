import { describe, expect, it } from 'vitest';
import {
  acceptErrorCopy,
  deadInviteCopy,
  INVITE_HEADLINE,
  inviteRoleNote,
  inviteRoleSentence,
  inviteStage,
  signInHref,
} from './invitePage';

describe('invite headline and role sentences', () => {
  it('keeps the headline short and role-free', () => {
    expect(INVITE_HEADLINE).toBe("You're invited");
  });

  it('names the role from the invitation', () => {
    expect(inviteRoleSentence('COACH')).toBe('Gym of Thrones invited you to join as Coach.');
    expect(inviteRoleSentence('FRONT_DESK')).toBe(
      'Gym of Thrones invited you to join as Front desk.',
    );
    expect(inviteRoleNote('FRONT_DESK')).toBe('It is to join Gym of Thrones as Front desk.');
  });
});

describe('deadInviteCopy', () => {
  it.each([
    ['STAFF_INVITE_EXPIRED', /expired/i],
    ['STAFF_INVITE_REVOKED', /withdrawn/i],
    ['STAFF_INVITE_USED', /already been used/i],
    ['STAFF_INVITE_NOT_FOUND', /isn't valid/i],
  ])('gives %s its own clear sentence', (code, title) => {
    expect(deadInviteCopy(code).title).toMatch(title);
  });

  it('tells an expired invitee what to do next', () => {
    expect(deadInviteCopy('STAFF_INVITE_EXPIRED').body).toMatch(/resend/i);
  });

  it('says "we could not open it" for anything else — a network failure is not a dead link', () => {
    expect(deadInviteCopy(null).title).toMatch(/couldn't open/i);
    expect(deadInviteCopy('HTTP_500').title).toMatch(/couldn't open/i);
  });
});

describe('acceptErrorCopy', () => {
  it('names the address the invitation was for when the wrong account is signed in', () => {
    const copy = acceptErrorCopy('STAFF_INVITE_EMAIL_MISMATCH', 'ma***@gmail.com');
    expect(copy.title).toMatch(/different email/i);
    expect(copy.body).toContain('ma***@gmail.com');
  });

  it('explains a role the inviter can no longer give', () => {
    expect(acceptErrorCopy('ROLE_NOT_ASSIGNABLE', 'x').body).toMatch(/new invitation/i);
  });

  it('explains an invitation that would lower their role', () => {
    expect(acceptErrorCopy('STAFF_INVITE_WOULD_DEMOTE', 'x').title).toMatch(/higher role/i);
  });

  it('falls back to the dead-link sentences for a link that died meanwhile', () => {
    expect(acceptErrorCopy('STAFF_INVITE_EXPIRED', 'x').title).toMatch(/expired/i);
  });

  it('asks for the emailed sign-in code rather than "try again" on LOGIN_CODE_REQUIRED', () => {
    const copy = acceptErrorCopy('LOGIN_CODE_REQUIRED', 'x');
    expect(copy.title).toBe('Finish signing in first');
    expect(copy.body).toMatch(/code we emailed/i);
    expect(copy.body).not.toMatch(/try again/i);
  });
});

describe('inviteStage', () => {
  it('waits for both the invitation and the session', () => {
    expect(inviteStage({ lookup: 'loading', session: 'signed-out', match: 'checking' })).toBe(
      'loading',
    );
    expect(inviteStage({ lookup: 'ok', session: 'checking', match: 'checking' })).toBe('loading');
  });

  it('shows a dead link whatever the session', () => {
    expect(inviteStage({ lookup: 'dead', session: 'signed-in', match: 'match' })).toBe('dead');
    expect(inviteStage({ lookup: 'dead', session: 'signed-in', match: 'mismatch' })).toBe('dead');
  });

  it('offers set-up when signed out, whatever an old match answer said', () => {
    expect(inviteStage({ lookup: 'ok', session: 'signed-out', match: 'checking' })).toBe(
      'signed-out',
    );
    expect(inviteStage({ lookup: 'ok', session: 'signed-out', match: 'mismatch' })).toBe(
      'signed-out',
    );
  });

  it('keeps loading while a signed-in session is being matched — no flash of Accept', () => {
    expect(inviteStage({ lookup: 'ok', session: 'signed-in', match: 'checking' })).toBe('loading');
  });

  it('offers Accept to the invited account', () => {
    expect(inviteStage({ lookup: 'ok', session: 'signed-in', match: 'match' })).toBe('signed-in');
  });

  it('shows the wrong-account face, not Accept, to a different account', () => {
    expect(inviteStage({ lookup: 'ok', session: 'signed-in', match: 'mismatch' })).toBe(
      'wrong-account',
    );
  });

  it('falls back to Accept when the match could not be checked', () => {
    expect(inviteStage({ lookup: 'ok', session: 'signed-in', match: 'unknown' })).toBe('signed-in');
  });
});

describe('signInHref', () => {
  it('comes back to this invitation after signing in', () => {
    expect(signInHref('abc_123')).toBe('/login?next=%2Finvite%2Fabc_123');
  });
});
