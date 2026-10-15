import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type { JWK, JWTVerifyGetKey } from 'jose';
import { verifyAccessToken } from './jwt-verifier';

const ISSUER = 'https://project.supabase.co/auth/v1';

// Derive the key type from the function itself — jose has changed this type
// between major versions (KeyObject / CryptoKey / KeyLike), and this form is
// correct on all of them.
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let privateKey: PrivateKey;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.alg = 'ES256';
  publicJwk.kid = 'test-key';
  keys = createLocalJWKSet({ keys: [publicJwk] });
});

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

async function sign(
  payload: Record<string, unknown>,
  expiresAt: number = nowSeconds() + 3600,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(privateKey);
}

/**
 * The date of birth was collected at registration from the very first
 * version and thrown away at every layer — required on the input, absent
 * from the signUp payload, no column, and dropped here by a five-field
 * whitelist. The system could not answer "is this member a minor?" for
 * anybody, which matters most for the waiver: a minor cannot legally sign
 * one alone.
 *
 * The rule is deliberately NOT "reject the registration". It is "do not
 * accept an unverified self-declared age below the joining age" — the
 * account is created, the date is simply not taken on trust, and staff enter
 * it in person with a guardian's consent.
 */
describe('verifyAccessToken — date of birth', () => {
  const withDob = async (dateOfBirth: unknown): Promise<string> =>
    sign({
      sub: '11111111-1111-1111-1111-111111111111',
      email: 'juan@example.com',
      user_metadata: { firstName: 'Juan', dateOfBirth },
    });

  const yearsAgo = (years: number): string => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    return d.toISOString().slice(0, 10);
  };

  it('accepts a plausible adult birth date as a civil-date string', async () => {
    const claims = await verifyAccessToken(await withDob(yearsAgo(30)), keys, ISSUER);
    expect(claims.dateOfBirth).toBe(yearsAgo(30));
  });

  it('accepts somebody exactly at the joining age', async () => {
    // A year past 16 rather than the boundary itself — the boundary lands on
    // a leap-year rounding edge that would make this test flaky one day in
    // four, and asserting the exact day is not what this rule is for.
    const claims = await verifyAccessToken(await withDob(yearsAgo(17)), keys, ISSUER);
    expect(claims.dateOfBirth).not.toBeNull();
  });

  it('does not take a self-declared age below the joining age on trust', async () => {
    const claims = await verifyAccessToken(await withDob(yearsAgo(12)), keys, ISSUER);
    expect(claims.dateOfBirth).toBeNull();
  });

  it.each<[unknown, string]>([
    ['2050-01-01', 'a date in the future'],
    ['1200-01-01', 'an implausible age'],
    ['01/01/1990', 'the wrong format'],
    ['', 'empty'],
    [42, 'not a string'],
    [null, 'null'],
  ])('drops %p (%s)', async (value) => {
    const claims = await verifyAccessToken(await withDob(value), keys, ISSUER);
    expect(claims.dateOfBirth).toBeNull();
  });

  it('is absent rather than undefined when the metadata omits it', async () => {
    const token = await sign({
      sub: '11111111-1111-1111-1111-111111111111',
      email: 'juan@example.com',
      user_metadata: { firstName: 'Juan' },
    });
    await expect(verifyAccessToken(token, keys, ISSUER)).resolves.toMatchObject({
      dateOfBirth: null,
    });
  });
});

describe('verifyAccessToken', () => {
  it('extracts claims from a valid token', async () => {
    const token = await sign({
      sub: '11111111-1111-1111-1111-111111111111',
      email: 'juan@example.com',
      user_metadata: {
        firstName: 'Juan',
        lastName: 'Dela Cruz',
        phone: '0917 000 0000',
        heightCm: 175,
        weightKg: 72.4,
      },
    });

    await expect(verifyAccessToken(token, keys, ISSUER)).resolves.toEqual({
      sub: '11111111-1111-1111-1111-111111111111',
      email: 'juan@example.com',
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      phone: '0917 000 0000',
      heightCm: 175,
      weightKg: 72.4,
      dateOfBirth: null,
    });
  });

  it('falls back to the email local-part when no name metadata is present', async () => {
    const token = await sign({
      sub: '22222222-2222-2222-2222-222222222222',
      email: 'ana@example.com',
    });

    const claims = await verifyAccessToken(token, keys, ISSUER);
    expect(claims.firstName).toBe('ana');
    expect(claims.lastName).toBe('');
    expect(claims.phone).toBeNull();
    expect(claims.heightCm).toBeNull();
    expect(claims.weightKg).toBeNull();
  });

  it('coerces numeric metadata sent as form strings', async () => {
    const token = await sign({
      sub: '66666666-6666-6666-6666-666666666666',
      email: 'form@example.com',
      user_metadata: { heightCm: '168', weightKg: '61.25' },
    });

    const claims = await verifyAccessToken(token, keys, ISSUER);
    expect(claims.heightCm).toBe(168);
    // Rounded to one decimal — a gym scale gives no more than that.
    expect(claims.weightKg).toBe(61.3);
  });

  it('discards out-of-range body metrics rather than storing them', async () => {
    const token = await sign({
      sub: '77777777-7777-7777-7777-777777777777',
      email: 'typo@example.com',
      // 4000kg is a typo, and 12cm is a unit mix-up. Keeping either would
      // poison any average or chart built on the column later.
      user_metadata: { heightCm: 12, weightKg: 4000 },
    });

    const claims = await verifyAccessToken(token, keys, ISSUER);
    expect(claims.heightCm).toBeNull();
    expect(claims.weightKg).toBeNull();
  });

  it('discards non-numeric body metrics', async () => {
    const token = await sign({
      sub: '88888888-8888-8888-8888-888888888888',
      email: 'junk@example.com',
      user_metadata: { heightCm: 'tall', weightKg: '' },
    });

    const claims = await verifyAccessToken(token, keys, ISSUER);
    expect(claims.heightCm).toBeNull();
    expect(claims.weightKg).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await sign(
      { sub: '33333333-3333-3333-3333-333333333333', email: 'old@example.com' },
      nowSeconds() - 3600,
    );

    await expect(verifyAccessToken(token, keys, ISSUER)).rejects.toThrow();
  });

  it('rejects a token from a different issuer', async () => {
    const token = await new SignJWT({
      sub: '44444444-4444-4444-4444-444444444444',
      email: 'x@y.z',
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer('https://evil.example.com/auth/v1')
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(nowSeconds() + 3600)
      .sign(privateKey);

    await expect(verifyAccessToken(token, keys, ISSUER)).rejects.toThrow();
  });

  it('rejects a token signed by an unknown key', async () => {
    const other = await generateKeyPair('ES256', { extractable: true });
    const token = await new SignJWT({
      sub: '55555555-5555-5555-5555-555555555555',
      email: 'a@b.c',
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(nowSeconds() + 3600)
      .sign(other.privateKey);

    await expect(verifyAccessToken(token, keys, ISSUER)).rejects.toThrow();
  });

  it('rejects a token with no sub claim', async () => {
    const token = await sign({ email: 'nosub@example.com' });
    await expect(verifyAccessToken(token, keys, ISSUER)).rejects.toThrow('missing sub');
  });
});
