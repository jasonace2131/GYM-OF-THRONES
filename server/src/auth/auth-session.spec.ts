import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EMAIL_LINK_AMR_METHODS, authSessionFrom } from './auth-session';

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'schema', 'migrations');

/** The amr list in the NEWEST migration that (re)creates login_session_verified(). */
function realtimeAmrList(): string[] {
  const latest = readdirSync(MIGRATIONS)
    .filter((name) => /^\d{14}_/.test(name))
    .sort()
    .map((name) => readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8'))
    .filter((sql) => sql.includes('FUNCTION public.login_session_verified()'))
    .pop();
  const list = /IN \(([^)]*)\)/.exec(latest ?? '');
  return (list?.[1] ?? '').split(',').map((item) => item.trim().replace(/'/g, ''));
}

const SESSION_ID = '99999999-9999-4999-8999-999999999999';

describe('authSessionFrom', () => {
  it('carries the sign-in id through', () => {
    expect(
      authSessionFrom({ sessionId: SESSION_ID, amr: ['password'], signedInAt: null }).sessionId,
    ).toBe(SESSION_ID);
  });

  it('carries the sign-in time through for the one-device rule, null included', () => {
    const at = new Date('2026-10-30T01:00:00.000Z');
    expect(
      authSessionFrom({ sessionId: SESSION_ID, amr: ['password'], signedInAt: at }).signedInAt,
    ).toEqual(at);
    expect(
      authSessionFrom({ sessionId: SESSION_ID, amr: ['password'], signedInAt: null }).signedInAt,
    ).toBeNull();
  });

  it.each(['otp', 'magiclink', 'invite', 'recovery', 'email_change'])(
    "treats '%s' as an email-link sign-in, even after a password step",
    (method) => {
      expect(
        authSessionFrom({ sessionId: SESSION_ID, amr: ['password', method], signedInAt: null })
          .viaEmailLink,
      ).toBe(true);
    },
  );

  it.each([[[]], [['password']], [['oauth']], [['totp']], [['token_refresh']]])(
    'does not treat %p as an email link',
    (amr) => {
      expect(authSessionFrom({ sessionId: SESSION_ID, amr, signedInAt: null }).viaEmailLink).toBe(
        false,
      );
    },
  );

  // feat/member-account: opening the email-change confirmation link proves
  // inbox access exactly as the other links do, and it lands as a fresh
  // session — without this the member is sent to the code step.
  it('lists exactly the five methods the Realtime migration also lists', () => {
    expect([...EMAIL_LINK_AMR_METHODS].sort()).toEqual([
      'email_change',
      'invite',
      'magiclink',
      'otp',
      'recovery',
    ]);
    expect(realtimeAmrList().sort()).toEqual([...EMAIL_LINK_AMR_METHODS].sort());
  });
});
