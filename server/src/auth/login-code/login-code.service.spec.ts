import { HttpStatus, Logger, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DomainException } from '../../common/exceptions/domain.exception';
import type { Env } from '../../config/env.validation';
import type { EmailService } from '../../notifications/email.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthSession, AuthUser } from '../auth.types';
import type { LoginGateService } from '../login-gate.service';
import { hashLoginCode } from './login-code.crypto';
import { LoginCodeService } from './login-code.service';

const PEPPER = 'z'.repeat(32);
const NOW = new Date('2026-10-15T02:00:00.000Z');
const SESSION: AuthSession = {
  sessionId: '99999999-9999-4999-8999-999999999999',
  viaEmailLink: false,
};
const USER = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  email: 'juana.cruz@gmail.com',
  firstName: 'Juana',
} as AuthUser;

interface Row {
  sessionId: string;
  userId: string;
  codeHash: string | null;
  codeExpiresAt: Date | null;
  attempts: number;
  sendCount: number;
  lastSentAt: Date | null;
  verifiedAt: Date | null;
  createdAt: Date;
}

const at = (msFromNow: number): Date => new Date(NOW.getTime() + msFromNow);
const hashOf = (code: string, sessionId = SESSION.sessionId): string =>
  hashLoginCode(PEPPER, sessionId, code);

/** A row with a live code '123456' sent `sentAgoMs` ago. */
const liveRow = (over: Partial<Row> = {}, sentAgoMs = 120_000): Row => ({
  sessionId: SESSION.sessionId,
  userId: USER.id,
  codeHash: hashOf('123456'),
  codeExpiresAt: at(-sentAgoMs + 600_000),
  attempts: 0,
  sendCount: 1,
  lastSentAt: at(-sentAgoMs),
  verifiedAt: null,
  createdAt: at(-sentAgoMs),
  ...over,
});

/** Enough of Prisma's `where` semantics for the guards this service writes. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key as keyof Row];
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (cond !== null && typeof cond === 'object' && 'lt' in cond) {
      return (value as number) < (cond as { lt: number }).lt;
    }
    return value === cond;
  });
}

function apply(row: Row, data: Record<string, unknown>): Row {
  const next: Record<string, unknown> = { ...row };
  for (const [key, change] of Object.entries(data)) {
    if (change !== null && typeof change === 'object' && !(change instanceof Date)) {
      const delta = change as { increment?: number; decrement?: number };
      next[key] = (next[key] as number) + (delta.increment ?? 0) - (delta.decrement ?? 0);
    } else {
      next[key] = change;
    }
  }
  return next as unknown as Row;
}

async function domainError(promise: Promise<unknown>): Promise<DomainException> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(DomainException);
  return caught as DomainException;
}

describe('LoginCodeService', () => {
  let row: Row | null;
  let hourSends: number;
  let prisma: {
    loginVerification: {
      createMany: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      aggregate: jest.Mock;
    };
  };
  let gate: { isVerified: jest.Mock; remember: jest.Mock };
  let email: { enabled: boolean; sendLoginCode: jest.Mock };
  let service: LoginCodeService;

  const sentCode = (call = 0): string =>
    (email.sendLoginCode.mock.calls[call] as [string, { code: string }])[1].code;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    row = null;
    hourSends = 0;
    prisma = {
      loginVerification: {
        createMany: jest.fn(({ data }: { data: Array<Partial<Row>> }) => {
          if (row !== null) return Promise.resolve({ count: 0 });
          row = {
            codeHash: null,
            codeExpiresAt: null,
            attempts: 0,
            sendCount: 0,
            lastSentAt: null,
            verifiedAt: null,
            ...(data[0] as Pick<Row, 'sessionId' | 'userId' | 'createdAt'>),
          };
          return Promise.resolve({ count: 1 });
        }),
        findUnique: jest.fn(() => Promise.resolve(row === null ? null : { ...row })),
        updateMany: jest.fn(
          ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            if (row === null || !matches(row, where)) return Promise.resolve({ count: 0 });
            row = apply(row, data);
            return Promise.resolve({ count: 1 });
          },
        ),
        aggregate: jest.fn(() => Promise.resolve({ _sum: { sendCount: hourSends } })),
      },
    };
    gate = { isVerified: jest.fn().mockResolvedValue(false), remember: jest.fn() };
    email = { enabled: true, sendLoginCode: jest.fn().mockResolvedValue(undefined) };
    service = new LoginCodeService(
      prisma as unknown as PrismaService,
      { get: () => PEPPER } as unknown as ConfigService<Env, true>,
      email as unknown as EmailService,
      gate as unknown as LoginGateService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('send', () => {
    it('sends nothing to a sign-in that is already verified', async () => {
      gate.isVerified.mockResolvedValue(true);
      await expect(service.send(USER, SESSION)).resolves.toEqual({ verified: true });
      expect(email.sendLoginCode).not.toHaveBeenCalled();
      expect(prisma.loginVerification.createMany).not.toHaveBeenCalled();
    });

    it('creates the row from the app clock, emails a 6-digit code, and stores only its HMAC', async () => {
      await expect(service.send(USER, SESSION)).resolves.toEqual({
        verified: false,
        sentTo: 'ju***@gmail.com',
        resendAvailableAt: at(60_000).toISOString(),
        expiresAt: at(600_000).toISOString(),
      });
      expect(prisma.loginVerification.createMany).toHaveBeenCalledWith({
        data: [{ sessionId: SESSION.sessionId, userId: USER.id, createdAt: NOW }],
        skipDuplicates: true,
      });
      expect(email.sendLoginCode).toHaveBeenCalledWith('juana.cruz@gmail.com', {
        name: 'Juana',
        code: expect.stringMatching(/^\d{6}$/) as unknown as string,
      });
      expect(row?.codeHash).toBe(hashOf(sentCode()));
      expect(row?.sendCount).toBe(1);
    });

    it('within 60 seconds returns the code already on its way, and sends nothing', async () => {
      row = liveRow({}, 30_000);
      await expect(service.send(USER, SESSION)).resolves.toEqual({
        verified: false,
        sentTo: 'ju***@gmail.com',
        resendAvailableAt: at(30_000).toISOString(),
        expiresAt: at(570_000).toISOString(),
      });
      expect(email.sendLoginCode).not.toHaveBeenCalled();
    });

    it('after 60 seconds replaces the code and resets the attempts', async () => {
      row = liveRow({ attempts: 3 }, 60_000);
      await service.send(USER, SESSION);
      expect(row?.codeHash).toBe(hashOf(sentCode()));
      expect(row?.attempts).toBe(0);
      expect(row?.sendCount).toBe(2);
      expect(row?.lastSentAt).toEqual(NOW);
    });

    it('stops at five codes for one sign-in with 429 LOGIN_CODE_SEND_LIMIT', async () => {
      row = liveRow({ sendCount: 5 }, 120_000);
      const error = await domainError(service.send(USER, SESSION));
      expect(error.code).toBe('LOGIN_CODE_SEND_LIMIT');
      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(email.sendLoginCode).not.toHaveBeenCalled();
    });

    it('stops at ten codes per account per rolling hour', async () => {
      hourSends = 10;
      const error = await domainError(service.send(USER, SESSION));
      expect(error.code).toBe('LOGIN_CODE_SEND_LIMIT');
      expect(prisma.loginVerification.aggregate).toHaveBeenCalledWith({
        where: { userId: USER.id, lastSentAt: { gt: at(-3_600_000) } },
        _sum: { sendCount: true },
      });
    });

    it('answers 503 LOGIN_CODE_EMAIL_FAILED when email is not configured, and counts nothing', async () => {
      email.enabled = false;
      const error = await domainError(service.send(USER, SESSION));
      expect(error.code).toBe('LOGIN_CODE_EMAIL_FAILED');
      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(row?.sendCount).toBe(0);
      expect(row?.codeHash).toBeNull();
    });

    it('un-counts a send Resend refused, and the previous code keeps working', async () => {
      row = liveRow({ attempts: 2 }, 120_000);
      const before = { ...row };
      email.sendLoginCode.mockRejectedValue(new Error('Resend send failed: quota'));
      const error = await domainError(service.send(USER, SESSION));
      expect(error.code).toBe('LOGIN_CODE_EMAIL_FAILED');
      expect(row).toEqual(before);
    });

    it('still answers LOGIN_CODE_EMAIL_FAILED when the un-count itself fails, and logs no code', async () => {
      row = liveRow({}, 120_000);
      email.sendLoginCode.mockRejectedValue(new Error('Resend send failed: quota'));
      const claim = prisma.loginVerification.updateMany.getMockImplementation();
      prisma.loginVerification.updateMany
        .mockImplementationOnce(claim as (...args: unknown[]) => unknown)
        .mockImplementationOnce(() => Promise.reject(new Error('P1001 pooler dropped')));
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const error = await domainError(service.send(USER, SESSION));
        expect(error.code).toBe('LOGIN_CODE_EMAIL_FAILED');
        expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        expect(logged).toHaveBeenCalledWith(expect.stringContaining('P1001 pooler dropped'));
        const sentHash = (row as Row).codeHash as string;
        for (const [message] of logged.mock.calls) {
          expect(String(message)).not.toContain(sentHash);
          expect(String(message)).not.toMatch(/\b\d{6}\b/);
        }
      } finally {
        logged.mockRestore();
        warned.mockRestore();
      }
    });

    it('a second tab losing the send race gets the winner’s state, not a second email', async () => {
      row = liveRow({}, 120_000);
      prisma.loginVerification.updateMany.mockImplementationOnce(() => {
        row = {
          ...(row as Row),
          sendCount: 2,
          lastSentAt: NOW,
          codeHash: hashOf('654321'),
          codeExpiresAt: at(600_000),
        };
        return Promise.resolve({ count: 0 });
      });
      await expect(service.send(USER, SESSION)).resolves.toMatchObject({
        verified: false,
        resendAvailableAt: at(60_000).toISOString(),
      });
      expect(email.sendLoginCode).not.toHaveBeenCalled();
    });

    it('reports a row verified meanwhile as verified, and warms the cache', async () => {
      row = liveRow({ codeHash: null, codeExpiresAt: null, verifiedAt: at(-1_000) });
      await expect(service.send(USER, SESSION)).resolves.toEqual({ verified: true });
      expect(gate.remember).toHaveBeenCalledWith(SESSION.sessionId);
    });

    it('refuses a sign-in row that belongs to another account', async () => {
      row = liveRow({ userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
      await expect(service.send(USER, SESSION)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('verify', () => {
    it('accepts the right code: sets verifiedAt, clears the hash, warms the cache', async () => {
      row = liveRow();
      await expect(service.verify(USER, SESSION, '123456')).resolves.toEqual({ verified: true });
      expect(row?.verifiedAt).toEqual(NOW);
      expect(row?.codeHash).toBeNull();
      expect(row?.codeExpiresAt).toBeNull();
      expect(gate.remember).toHaveBeenCalledWith(SESSION.sessionId);
    });

    it('never writes verifiedAt before createdAt, even when the clock stepped back', async () => {
      row = liveRow({ createdAt: at(2_000) });
      await service.verify(USER, SESSION, '123456');
      expect(row?.verifiedAt).toEqual(at(2_000));
    });

    it('answers a wrong code 422 LOGIN_CODE_INVALID with attempts left', async () => {
      row = liveRow();
      const error = await domainError(service.verify(USER, SESSION, '000000'));
      expect(error.code).toBe('LOGIN_CODE_INVALID');
      expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(error.details).toEqual({ attemptsLeft: 4 });
      expect(row?.attempts).toBe(1);
    });

    it('answers the fifth wrong guess LOGIN_CODE_LOCKED', async () => {
      row = liveRow({ attempts: 4 });
      const error = await domainError(service.verify(USER, SESSION, '000000'));
      expect(error.code).toBe('LOGIN_CODE_LOCKED');
      expect(row?.attempts).toBe(5);
    });

    it('keeps a burned code burned, even for the right digits', async () => {
      row = liveRow({ attempts: 5 });
      expect((await domainError(service.verify(USER, SESSION, '123456'))).code).toBe(
        'LOGIN_CODE_LOCKED',
      );
    });

    it('expires a code AT its expiry instant, and accepts it a millisecond before', async () => {
      row = liveRow({ codeExpiresAt: NOW });
      expect((await domainError(service.verify(USER, SESSION, '123456'))).code).toBe(
        'LOGIN_CODE_EXPIRED',
      );
      row = liveRow({ codeExpiresAt: at(1) });
      await expect(service.verify(USER, SESSION, '123456')).resolves.toEqual({ verified: true });
    });

    it('answers EXPIRED when no code was ever sent', async () => {
      expect((await domainError(service.verify(USER, SESSION, '123456'))).code).toBe(
        'LOGIN_CODE_EXPIRED',
      );
    });

    it('is a no-op for a sign-in already verified (a second tab)', async () => {
      gate.isVerified.mockResolvedValue(true);
      await expect(service.verify(USER, SESSION, '999999')).resolves.toEqual({ verified: true });
      expect(prisma.loginVerification.findUnique).not.toHaveBeenCalled();
    });

    it('two tabs with the right code: the loser still hears verified', async () => {
      row = liveRow();
      prisma.loginVerification.updateMany.mockImplementationOnce(() => {
        row = { ...(row as Row), verifiedAt: NOW, codeHash: null, codeExpiresAt: null };
        return Promise.resolve({ count: 0 });
      });
      await expect(service.verify(USER, SESSION, '123456')).resolves.toEqual({ verified: true });
    });

    it('a right code that a resend replaced mid-request is EXPIRED, not verified', async () => {
      row = liveRow();
      prisma.loginVerification.updateMany.mockImplementationOnce(() => {
        row = { ...(row as Row), codeHash: hashOf('654321'), sendCount: 2 };
        return Promise.resolve({ count: 0 });
      });
      expect((await domainError(service.verify(USER, SESSION, '123456'))).code).toBe(
        'LOGIN_CODE_EXPIRED',
      );
      expect(gate.remember).not.toHaveBeenCalled();
    });

    it('a wrong guess against a replaced code never counts against the new code', async () => {
      row = liveRow();
      prisma.loginVerification.updateMany.mockImplementationOnce(() => {
        row = { ...(row as Row), codeHash: hashOf('654321'), attempts: 0, sendCount: 2 };
        return Promise.resolve({ count: 0 });
      });
      const error = await domainError(service.verify(USER, SESSION, '000000'));
      expect(error.code).toBe('LOGIN_CODE_INVALID');
      expect(error.details).toEqual({ attemptsLeft: 5 });
      expect(row?.attempts).toBe(0);
    });

    it('a wrong guess racing a failed resend that left no code at all is EXPIRED', async () => {
      row = liveRow();
      prisma.loginVerification.updateMany.mockImplementationOnce(() => {
        row = { ...(row as Row), codeHash: null, codeExpiresAt: null };
        return Promise.resolve({ count: 0 });
      });
      expect((await domainError(service.verify(USER, SESSION, '000000'))).code).toBe(
        'LOGIN_CODE_EXPIRED',
      );
    });

    it('a right code that other tabs burned with wrong guesses mid-request is LOCKED', async () => {
      row = liveRow({ attempts: 4 });
      prisma.loginVerification.updateMany.mockImplementationOnce(() => {
        row = { ...(row as Row), attempts: 5 };
        return Promise.resolve({ count: 0 });
      });
      expect((await domainError(service.verify(USER, SESSION, '123456'))).code).toBe(
        'LOGIN_CODE_LOCKED',
      );
      expect(gate.remember).not.toHaveBeenCalled();
    });

    it('only the latest code works after a resend', async () => {
      row = liveRow({}, 120_000);
      await service.send(USER, SESSION);
      expect((await domainError(service.verify(USER, SESSION, '123456'))).code).toBe(
        'LOGIN_CODE_INVALID',
      );
      await expect(service.verify(USER, SESSION, sentCode())).resolves.toEqual({ verified: true });
    });

    it('a code is bound to its sign-in: the same digits hashed for another session fail', async () => {
      row = liveRow({ codeHash: hashOf('123456', '88888888-8888-4888-8888-888888888888') });
      expect((await domainError(service.verify(USER, SESSION, '123456'))).code).toBe(
        'LOGIN_CODE_INVALID',
      );
    });
  });
});
