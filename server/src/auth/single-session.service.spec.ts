import { HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';
import type { PrismaService } from '../prisma/prisma.service';
import type { ActiveSession, AuthSession } from './auth.types';
import {
  SESSION_REPLACED_MESSAGE,
  SingleSessionService,
  sessionVerdict,
} from './single-session.service';

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const THIS_DEVICE = '99999999-9999-4999-8999-999999999999';
const OTHER_DEVICE = '88888888-8888-4888-8888-888888888888';

const EARLIER = new Date('2026-10-30T01:00:00.000Z');
const LATER = new Date('2026-10-30T02:00:00.000Z');

const session = (signedInAt: Date | null): AuthSession => ({
  sessionId: THIS_DEVICE,
  viaEmailLink: false,
  signedInAt,
});

const NOBODY: ActiveSession = { sessionId: null, signedInAt: null };
const held = (sessionId: string, signedInAt: Date | null): ActiveSession => ({
  sessionId,
  signedInAt,
});

function build(
  required = true,
  claimCount = 1,
  reread: { activeSessionId: string | null } | null = null,
): { service: SingleSessionService; updateMany: jest.Mock; findUnique: jest.Mock } {
  const updateMany = jest.fn().mockResolvedValue({ count: claimCount });
  const findUnique = jest.fn().mockResolvedValue(reread);
  const service = new SingleSessionService(
    { user: { updateMany, findUnique } } as unknown as PrismaService,
    { get: () => required } as unknown as ConfigService<Env, true>,
  );
  return { service, updateMany, findUnique };
}

async function caughtFrom(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe('sessionVerdict', () => {
  it('claims an account nobody holds', () => {
    expect(sessionVerdict(NOBODY, session(EARLIER))).toBe('claim');
  });

  it('allows the sign-in that holds the account, whatever its time', () => {
    expect(sessionVerdict(held(THIS_DEVICE, EARLIER), session(LATER))).toBe('allow');
    expect(sessionVerdict(held(THIS_DEVICE, null), session(null))).toBe('allow');
  });

  it('claims for a NEWER sign-in: it is the new device', () => {
    expect(sessionVerdict(held(OTHER_DEVICE, EARLIER), session(LATER))).toBe('claim');
  });

  it('rejects an OLDER sign-in: another device signed in after it', () => {
    expect(sessionVerdict(held(OTHER_DEVICE, LATER), session(EARLIER))).toBe('reject');
  });

  it('rejects a sign-in at the SAME time: the first to claim keeps it', () => {
    expect(sessionVerdict(held(OTHER_DEVICE, EARLIER), session(EARLIER))).toBe('reject');
  });

  it('never lets an untimed sign-in displace another device', () => {
    expect(sessionVerdict(held(OTHER_DEVICE, EARLIER), session(null))).toBe('reject');
    expect(sessionVerdict(held(OTHER_DEVICE, null), session(null))).toBe('reject');
  });

  it('lets an untimed sign-in claim an account nobody holds', () => {
    expect(sessionVerdict(NOBODY, session(null))).toBe('claim');
  });

  it('lets any timed sign-in take over from an untimed holder', () => {
    expect(sessionVerdict(held(OTHER_DEVICE, null), session(EARLIER))).toBe('claim');
  });
});

describe('SingleSessionService', () => {
  it('reads, writes and refuses nothing when the kill switch is off', async () => {
    const { service, updateMany, findUnique } = build(false);
    await expect(
      service.assertCurrent(USER_ID, held(OTHER_DEVICE, LATER), session(EARLIER)),
    ).resolves.toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('lets the holder through with no write and no query: the steady state is free', async () => {
    const { service, updateMany, findUnique } = build();
    await expect(
      service.assertCurrent(USER_ID, held(THIS_DEVICE, EARLIER), session(EARLIER)),
    ).resolves.toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('claims an unheld account with a conditional write', async () => {
    const { service, updateMany } = build();
    await service.assertCurrent(USER_ID, NOBODY, session(EARLIER));
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        OR: [
          { activeSessionId: null },
          { activeSessionId: THIS_DEVICE },
          { activeSessionSignedInAt: null },
          { activeSessionSignedInAt: { lt: EARLIER } },
        ],
      },
      data: { activeSessionId: THIS_DEVICE, activeSessionSignedInAt: EARLIER },
    });
  });

  it('takes the account from an older device', async () => {
    const { service, updateMany, findUnique } = build();
    await expect(
      service.assertCurrent(USER_ID, held(OTHER_DEVICE, EARLIER), session(LATER)),
    ).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].data).toEqual({
      activeSessionId: THIS_DEVICE,
      activeSessionSignedInAt: LATER,
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('answers an older device 401 SESSION_REPLACED, without writing', async () => {
    const { service, updateMany } = build();
    const caught = await caughtFrom(
      service.assertCurrent(USER_ID, held(OTHER_DEVICE, LATER), session(EARLIER)),
    );
    expect(caught).toBeInstanceOf(DomainException);
    expect((caught as DomainException).code).toBe('SESSION_REPLACED');
    expect((caught as DomainException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect((caught as DomainException).message).toBe(SESSION_REPLACED_MESSAGE);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('uses the words the owner chose', () => {
    expect(SESSION_REPLACED_MESSAGE).toBe(
      'You were signed out because your account signed in on another device.',
    );
  });

  describe('two devices racing', () => {
    it('re-reads after a lost claim and refuses when another device won', async () => {
      const { service, findUnique } = build(true, 0, { activeSessionId: OTHER_DEVICE });
      const caught = await caughtFrom(
        service.assertCurrent(USER_ID, held(OTHER_DEVICE, EARLIER), session(LATER)),
      );
      expect((caught as DomainException).code).toBe('SESSION_REPLACED');
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: USER_ID },
        select: { activeSessionId: true },
      });
    });

    it('re-reads after a lost claim and allows when this sign-in won (a second tab)', async () => {
      const { service } = build(true, 0, { activeSessionId: THIS_DEVICE });
      await expect(service.assertCurrent(USER_ID, NOBODY, session(EARLIER))).resolves.toBe(
        undefined,
      );
    });

    it('refuses when the re-read finds no row', async () => {
      const { service } = build(true, 0, null);
      const caught = await caughtFrom(service.assertCurrent(USER_ID, NOBODY, session(EARLIER)));
      expect((caught as DomainException).code).toBe('SESSION_REPLACED');
    });
  });

  describe('a sign-in with no time', () => {
    it('claims an unheld account, but only while it is still unheld', async () => {
      const { service, updateMany } = build();
      await service.assertCurrent(USER_ID, NOBODY, session(null));
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: USER_ID,
          OR: [{ activeSessionId: null }, { activeSessionId: THIS_DEVICE }],
        },
        data: { activeSessionId: THIS_DEVICE, activeSessionSignedInAt: null },
      });
    });

    it('never displaces another device, and never writes trying', async () => {
      const { service, updateMany } = build();
      const caught = await caughtFrom(
        service.assertCurrent(USER_ID, held(OTHER_DEVICE, EARLIER), session(null)),
      );
      expect((caught as DomainException).code).toBe('SESSION_REPLACED');
      expect(updateMany).not.toHaveBeenCalled();
    });
  });
});
