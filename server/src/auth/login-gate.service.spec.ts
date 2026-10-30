import { HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthSession } from './auth.types';
import { LoginGateService, VERIFIED_SESSION_CACHE_SIZE } from './login-gate.service';

const SESSION: AuthSession = {
  sessionId: '99999999-9999-4999-8999-999999999999',
  viaEmailLink: false,
  signedInAt: null,
};

function build(
  required: boolean,
  row: { verifiedAt: Date | null } | null = null,
): { gate: LoginGateService; findUnique: jest.Mock } {
  const findUnique = jest.fn().mockResolvedValue(row);
  const gate = new LoginGateService(
    { loginVerification: { findUnique } } as unknown as PrismaService,
    { get: () => required } as unknown as ConfigService<Env, true>,
  );
  return { gate, findUnique };
}

describe('LoginGateService', () => {
  it('lets every sign-in through, without a query, when the kill switch is off', async () => {
    const { gate, findUnique } = build(false);
    await expect(gate.isVerified(SESSION)).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('trusts an email-link sign-in without a query', async () => {
    const { gate, findUnique } = build(true);
    await expect(gate.isVerified({ ...SESSION, viaEmailLink: true })).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('accepts a sign-in whose code was entered, and caches it', async () => {
    const { gate, findUnique } = build(true, { verifiedAt: new Date() });
    await expect(gate.isVerified(SESSION)).resolves.toBe(true);
    await expect(gate.isVerified(SESSION)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { sessionId: SESSION.sessionId },
      select: { verifiedAt: true },
    });
  });

  it('keys on the sign-in, not the token: a refreshed token of a verified sign-in is never asked again', async () => {
    const { gate, findUnique } = build(true);
    gate.remember(SESSION.sessionId);
    // A refreshed token carries the same session_id and nothing else the gate reads.
    await expect(
      gate.isVerified({ sessionId: SESSION.sessionId, viaEmailLink: false, signedInAt: null }),
    ).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('refuses a sign-in with a row but no verifiedAt, and never caches the refusal', async () => {
    const { gate, findUnique } = build(true, { verifiedAt: null });
    await expect(gate.isVerified(SESSION)).resolves.toBe(false);
    await expect(gate.isVerified(SESSION)).resolves.toBe(false);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('refuses a sign-in with no row at all', async () => {
    const { gate } = build(true, null);
    await expect(gate.isVerified(SESSION)).resolves.toBe(false);
  });

  it('evicts the coldest sign-in past the cache size, and a hit refreshes recency', async () => {
    const { gate, findUnique } = build(true, null);
    const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

    gate.remember(id(0));
    gate.remember(id(1));
    for (let n = 2; n < VERIFIED_SESSION_CACHE_SIZE; n += 1) gate.remember(id(n));
    // id(0) is touched, so id(1) is now the coldest.
    await expect(gate.isVerified({ ...SESSION, sessionId: id(0) })).resolves.toBe(true);
    gate.remember(id(VERIFIED_SESSION_CACHE_SIZE));

    await expect(gate.isVerified({ ...SESSION, sessionId: id(0) })).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
    await expect(gate.isVerified({ ...SESSION, sessionId: id(1) })).resolves.toBe(false);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  describe('assertVerified', () => {
    it('throws 401 LOGIN_CODE_REQUIRED for an unverified sign-in', async () => {
      const { gate } = build(true, null);
      const caught = await gate.assertVerified(SESSION, false).then(
        () => null,
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(DomainException);
      expect((caught as DomainException).code).toBe('LOGIN_CODE_REQUIRED');
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('lets an exempt route through without a query', async () => {
      const { gate, findUnique } = build(true, null);
      await expect(gate.assertVerified(SESSION, true)).resolves.toBeUndefined();
      expect(findUnique).not.toHaveBeenCalled();
    });

    it('resolves for a verified sign-in', async () => {
      const { gate } = build(true, { verifiedAt: new Date() });
      await expect(gate.assertVerified(SESSION, false)).resolves.toBeUndefined();
    });
  });
});
