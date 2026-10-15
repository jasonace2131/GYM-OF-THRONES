import { EMAIL_LINK_AMR_METHODS, authSessionFrom } from './auth-session';

const SESSION_ID = '99999999-9999-4999-8999-999999999999';

describe('authSessionFrom', () => {
  it('carries the sign-in id through', () => {
    expect(authSessionFrom({ sessionId: SESSION_ID, amr: ['password'] }).sessionId).toBe(
      SESSION_ID,
    );
  });

  it.each(['otp', 'magiclink', 'invite', 'recovery'])(
    "treats '%s' as an email-link sign-in, even after a password step",
    (method) => {
      expect(
        authSessionFrom({ sessionId: SESSION_ID, amr: ['password', method] }).viaEmailLink,
      ).toBe(true);
    },
  );

  it.each([[[]], [['password']], [['oauth']], [['totp']], [['token_refresh']]])(
    'does not treat %p as an email link',
    (amr) => {
      expect(authSessionFrom({ sessionId: SESSION_ID, amr }).viaEmailLink).toBe(false);
    },
  );

  it('lists exactly the four methods the Realtime migration also lists', () => {
    expect([...EMAIL_LINK_AMR_METHODS].sort()).toEqual(['invite', 'magiclink', 'otp', 'recovery']);
  });
});
