import { createHash } from 'node:crypto';
import {
  INVITATION_TTL_DAYS,
  hashInvitationToken,
  invitationExpiry,
  invitationStatus,
  maskEmail,
  newInvitationToken,
  normaliseInviteEmail,
} from './invitation-token';

describe('newInvitationToken', () => {
  it('mints a url-safe token from 32 random bytes, and its sha256 hex', () => {
    const { token, tokenHash } = newInvitationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never mints the same token twice', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newInvitationToken().token));
    expect(tokens.size).toBe(50);
  });
});

describe('hashInvitationToken', () => {
  it('is the same hash the minted pair carries — lookups find the row', () => {
    const { token, tokenHash } = newInvitationToken();
    expect(hashInvitationToken(token)).toBe(tokenHash);
  });
});

describe('normaliseInviteEmail', () => {
  it('trims and lowercases — one address, one row', () => {
    expect(normaliseInviteEmail('  Ana.Cruz@Gmail.COM ')).toBe('ana.cruz@gmail.com');
  });
});

describe('maskEmail', () => {
  it('keeps the first two characters of the local part and the whole domain', () => {
    expect(maskEmail('maria.santos@gmail.com')).toBe('ma***@gmail.com');
  });

  it('keeps one character of a one- or two-character local part', () => {
    expect(maskEmail('m@x.ph')).toBe('m***@x.ph');
    expect(maskEmail('jo@x.ph')).toBe('j***@x.ph');
  });

  it('never echoes a string that is not an address', () => {
    expect(maskEmail('not-an-address')).toBe('***');
  });
});

describe('invitationExpiry', () => {
  it(`is ${INVITATION_TTL_DAYS} days after issue`, () => {
    const now = new Date('2026-09-25T00:00:00.000Z');
    expect(invitationExpiry(now).toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });
});

describe('invitationStatus', () => {
  const now = new Date('2026-09-25T12:00:00.000Z');
  const open = {
    acceptedAt: null,
    revokedAt: null,
    expiresAt: new Date('2026-09-30T00:00:00.000Z'),
  };

  it('is PENDING while open and in date', () => {
    expect(invitationStatus(open, now)).toBe('PENDING');
  });

  it('is EXPIRED at the expiry instant, not a millisecond later', () => {
    expect(invitationStatus({ ...open, expiresAt: now }, now)).toBe('EXPIRED');
  });

  it('is ACCEPTED or REVOKED whatever the clock says', () => {
    const past = new Date('2026-09-01T00:00:00.000Z');
    expect(invitationStatus({ ...open, acceptedAt: past, expiresAt: past }, now)).toBe('ACCEPTED');
    expect(invitationStatus({ ...open, revokedAt: past, expiresAt: past }, now)).toBe('REVOKED');
  });
});
