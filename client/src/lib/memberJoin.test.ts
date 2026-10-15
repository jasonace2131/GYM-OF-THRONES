import { beforeEach, describe, expect, it, vi } from 'vitest';

// `./api` builds the Supabase client at import, which needs env the unit run lacks.
vi.mock('./api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from './api';
import {
  birthDateProblem,
  dayBefore,
  deadJoinCopy,
  isSamePasswordError,
  joinErrorCopy,
  joinStage,
  memberJoinApi,
  passwordStep,
} from './memberJoin';

const pending = { firstName: 'Ana', status: 'PENDING' as const, email: 'ana@example.com' };

describe('joinStage', () => {
  it('waits while the link or the session is still loading', () => {
    expect(joinStage({ lookup: 'loading', link: null, sessionEmail: undefined })).toBe('loading');
    expect(joinStage({ lookup: 'ok', link: pending, sessionEmail: undefined })).toBe('loading');
  });

  it('shows the dead face for a failed lookup, a used link and an expired one', () => {
    expect(joinStage({ lookup: 'dead', link: null, sessionEmail: null })).toBe('dead');
    expect(
      joinStage({ lookup: 'ok', link: { firstName: 'Ana', status: 'USED' }, sessionEmail: null }),
    ).toBe('dead');
    expect(
      joinStage({
        lookup: 'ok',
        link: { firstName: 'Ana', status: 'EXPIRED' },
        sessionEmail: null,
      }),
    ).toBe('dead');
  });

  it('offers "Set up my account" when nobody is signed in', () => {
    expect(joinStage({ lookup: 'ok', link: pending, sessionEmail: null })).toBe('signed-out');
  });

  it('shows the password form only to the member themselves — case-insensitively', () => {
    expect(joinStage({ lookup: 'ok', link: pending, sessionEmail: 'ana@example.com' })).toBe(
      'signed-in',
    );
    expect(joinStage({ lookup: 'ok', link: pending, sessionEmail: 'Ana@Example.COM' })).toBe(
      'signed-in',
    );
  });

  it('matches through stray whitespace on either side', () => {
    expect(joinStage({ lookup: 'ok', link: pending, sessionEmail: '  ana@example.com ' })).toBe(
      'signed-in',
    );
    expect(
      joinStage({
        lookup: 'ok',
        link: { ...pending, email: ' Ana@example.com ' },
        sessionEmail: 'ana@example.com',
      }),
    ).toBe('signed-in');
  });

  it('NEVER shows the password form to another account signed in on this computer', () => {
    // An admin on the desk PC opening a member's link must not change their OWN password.
    expect(joinStage({ lookup: 'ok', link: pending, sessionEmail: 'admin@gym.test' })).toBe(
      'signed-in-other',
    );
  });

  it('fails CLOSED when the link carries no email — even for an empty session email', () => {
    const noEmail = { firstName: 'Ana', status: 'PENDING' as const };
    for (const sessionEmail of ['', '   ', 'ana@example.com']) {
      expect(joinStage({ lookup: 'ok', link: noEmail, sessionEmail })).toBe('signed-in-other');
      expect(joinStage({ lookup: 'ok', link: { ...noEmail, email: '  ' }, sessionEmail })).toBe(
        'signed-in-other',
      );
    }
  });
});

describe('dayBefore', () => {
  it('steps back one calendar day, across month and year ends and a leap day', () => {
    expect(dayBefore('2026-10-14')).toBe('2026-10-13');
    expect(dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(dayBefore('2028-03-01')).toBe('2028-02-29');
    expect(dayBefore('2027-01-01')).toBe('2026-12-31');
  });

  it('is a date birthDateProblem accepts — the picker never offers a refused day', () => {
    expect(birthDateProblem(dayBefore('2026-10-14'), '2026-10-14')).toBeNull();
  });
});

describe('deadJoinCopy', () => {
  it('tells a used link to sign in', () => {
    expect(deadJoinCopy({ status: 'USED', code: null }).title).toMatch(/already set up/i);
    expect(deadJoinCopy({ status: 'USED', code: null }).body).toMatch(/sign in/i);
  });

  it('tells an expired link it has expired, and to ask the front desk', () => {
    for (const input of [
      { status: 'EXPIRED' as const, code: null },
      { status: null, code: 'MEMBER_JOIN_EXPIRED' },
    ]) {
      expect(deadJoinCopy(input).title).toBe('This link has expired');
      expect(deadJoinCopy(input).body).toMatch(/front desk/i);
    }
  });

  it('calls an unknown link "not valid", not expired', () => {
    const copy = deadJoinCopy({ status: null, code: 'MEMBER_JOIN_NOT_FOUND' });
    expect(copy.title).toBe("This link isn't valid");
    expect(copy.body).toMatch(/front desk/i);
  });

  it('calls a mangled token (any other code, e.g. HTTP_400) "not valid", not the connection', () => {
    for (const code of ['HTTP_400', 'SOMETHING_NEW']) {
      const copy = deadJoinCopy({ status: null, code });
      expect(copy.title).toBe("This link isn't valid");
      expect(copy.body).toMatch(/front desk/i);
    }
  });

  it('does not call a network failure (no code at all) a dead link', () => {
    expect(deadJoinCopy({ status: null, code: null }).title).toMatch(/couldn't open/i);
  });
});

describe('joinErrorCopy', () => {
  it('explains a different signed-in account', () => {
    expect(joinErrorCopy('MEMBER_JOIN_WRONG_ACCOUNT').title).toMatch(/different account/i);
  });

  it('explains switched-off set-up', () => {
    expect(joinErrorCopy('MEMBER_CREATE_DISABLED').title).toMatch(/not available/i);
  });

  it('explains a link for an account that is now staff', () => {
    expect(joinErrorCopy('MEMBER_JOIN_STAFF_ACCOUNT')).toEqual({
      title: 'This link is not for a member account',
      body: 'Staff accounts are set up from Staff & Access. Ask the gym.',
    });
  });

  it('falls back to "try again" for anything else', () => {
    expect(joinErrorCopy(null).body).toMatch(/try again/i);
  });
});

describe('birthDateProblem', () => {
  const today = '2026-10-14';

  it('accepts a real past date', () => {
    expect(birthDateProblem('1995-03-02', today)).toBeNull();
  });

  it('asks for a date when blank or malformed', () => {
    expect(birthDateProblem('', today)).toMatch(/date of birth/i);
    expect(birthDateProblem('02/03/1995', today)).toMatch(/date of birth/i);
  });

  it('refuses a date in the future or today', () => {
    expect(birthDateProblem('2026-10-14', today)).toMatch(/past/i);
    expect(birthDateProblem('2030-01-01', today)).toMatch(/past/i);
  });

  it('refuses a date more than 120 years ago', () => {
    expect(birthDateProblem('1900-01-01', today)).toMatch(/check the year/i);
  });
});

describe('passwordStep', () => {
  it('skips the save on a retry with the password already saved', () => {
    expect(passwordStep({ next: 'hunter2hunter2', savedPassword: 'hunter2hunter2' })).toBe('skip');
  });

  it('saves a different password', () => {
    expect(passwordStep({ next: 'another-one', savedPassword: 'hunter2hunter2' })).toBe('save');
  });

  it('saves when nothing has been saved yet', () => {
    expect(passwordStep({ next: 'hunter2hunter2', savedPassword: null })).toBe('save');
  });
});

describe('isSamePasswordError', () => {
  it("treats Supabase's same_password refusal as already saved", () => {
    expect(isSamePasswordError({ code: 'same_password' })).toBe(true);
  });

  it('does not treat any other error, or none, as saved', () => {
    expect(isSamePasswordError({ code: 'weak_password' })).toBe(false);
    expect(isSamePasswordError({ code: undefined })).toBe(false);
    expect(isSamePasswordError(null)).toBe(false);
  });
});

describe('memberJoinApi', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
  });

  it('looks the token up with it encoded in the query', async () => {
    await memberJoinApi.lookup('a/b+c');
    expect(apiFetch).toHaveBeenCalledWith('/member-join/lookup?token=a%2Fb%2Bc');
  });

  it('claims and accepts with a POST body', async () => {
    await memberJoinApi.claimLink('tok');
    expect(apiFetch).toHaveBeenLastCalledWith('/member-join/claim-link', {
      method: 'POST',
      body: JSON.stringify({ token: 'tok' }),
    });
    await memberJoinApi.accept('tok', '1995-03-02');
    expect(apiFetch).toHaveBeenLastCalledWith('/member-join/accept', {
      method: 'POST',
      body: JSON.stringify({ token: 'tok', dateOfBirth: '1995-03-02' }),
    });
  });
});
