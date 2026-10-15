import { createHmac } from 'node:crypto';
import { generateLoginCode, hashLoginCode, loginCodeMatches } from './login-code.crypto';

const PEPPER = 'z'.repeat(32);
const SESSION_A = '99999999-9999-4999-8999-999999999999';
const SESSION_B = '88888888-8888-4888-8888-888888888888';

describe('generateLoginCode', () => {
  it('draws from 0..999999 and zero-pads to six digits', () => {
    const draw = jest.fn().mockReturnValue(42);
    expect(generateLoginCode(draw)).toBe('000042');
    expect(draw).toHaveBeenCalledWith(0, 1_000_000);
  });

  it('keeps the top of the range as six digits', () => {
    expect(generateLoginCode(() => 999_999)).toBe('999999');
  });

  it('produces six digits from the real generator', () => {
    for (let i = 0; i < 50; i += 1) expect(generateLoginCode()).toMatch(/^\d{6}$/);
  });
});

describe('hashLoginCode', () => {
  it('is HMAC-SHA256 keyed by the pepper over the domain-separated string', () => {
    const expected = createHmac('sha256', PEPPER)
      .update(`login-code:v1:${SESSION_A}:123456`)
      .digest('hex');
    expect(hashLoginCode(PEPPER, SESSION_A, '123456')).toBe(expected);
  });

  it('is 64 lower-case hex characters — what LoginVerification_code_hash_shape demands', () => {
    expect(hashLoginCode(PEPPER, SESSION_A, '000000')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds the code to its sign-in: the same code hashes differently for another session', () => {
    expect(hashLoginCode(PEPPER, SESSION_A, '123456')).not.toBe(
      hashLoginCode(PEPPER, SESSION_B, '123456'),
    );
  });

  it('is useless without the server secret: another pepper gives another hash', () => {
    expect(hashLoginCode(PEPPER, SESSION_A, '123456')).not.toBe(
      hashLoginCode('y'.repeat(32), SESSION_A, '123456'),
    );
  });
});

describe('loginCodeMatches', () => {
  const stored = hashLoginCode(PEPPER, SESSION_A, '123456');

  it('matches the same hash', () => {
    expect(loginCodeMatches(hashLoginCode(PEPPER, SESSION_A, '123456'), stored)).toBe(true);
  });

  it('does not match another code', () => {
    expect(loginCodeMatches(hashLoginCode(PEPPER, SESSION_A, '123457'), stored)).toBe(false);
  });

  it('returns false, never throws, for a malformed hash', () => {
    expect(loginCodeMatches('abc', stored)).toBe(false);
    expect(loginCodeMatches(stored, '')).toBe(false);
  });
});
