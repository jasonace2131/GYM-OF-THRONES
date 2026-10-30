import {
  ExecutionContext,
  ForbiddenException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';
import type { PrismaService } from '../prisma/prisma.service';
import type { JwtVerifierService } from '../auth/jwt-verifier.service';
import type { UserProvisioningService } from '../auth/user-provisioning.service';
import type { PermissionsService } from '../rbac/permissions.service';
import type { LoginGateService } from '../auth/login-gate.service';
import type { SingleSessionService } from '../auth/single-session.service';
import type { ActiveSession, AuthSession, AuthUser, SupabaseClaims } from '../auth/auth.types';
import {
  STATION_TOKEN_ISSUE_PERMISSION,
  StationTokenAccessGuard,
  type RequestWithStationAccess,
} from './station.guard';

const CLAIMS: SupabaseClaims = {
  sub: '11111111-1111-1111-1111-111111111111',
  email: 'desk@example.com',
  firstName: 'Desk',
  lastName: 'Staff',
  phone: null,
  heightCm: null,
  weightKg: null,
  dateOfBirth: null,
  sessionId: '99999999-9999-4999-8999-999999999999',
  amr: ['password'],
  signedInAt: new Date('2026-10-30T01:00:00.000Z'),
};

const SESSION: AuthSession = {
  sessionId: CLAIMS.sessionId,
  viaEmailLink: false,
  signedInAt: CLAIMS.signedInAt,
};

/** This sign-in already holds the account. */
const HELD: ActiveSession = { sessionId: CLAIMS.sessionId, signedInAt: CLAIMS.signedInAt };

const STAFF: AuthUser = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  supabaseId: CLAIMS.sub,
  email: CLAIMS.email,
  firstName: 'Desk',
  lastName: 'Staff',
  role: 'FRONT_DESK',
  status: 'ACTIVE',
  permissionVersion: 0,
  heightCm: null,
  weightKg: null,
  deletedAt: null,
};

/**
 * The staff-preview path verifies JWTs BY HAND, outside AuthGuard, so it must
 * run the same emailed-code gate — or a stolen password would open the
 * station display's token feed. The credential path has no user at all and
 * never asks.
 */
describe('StationTokenAccessGuard — emailed sign-in code', () => {
  let assertVerified: jest.Mock;
  let assertCurrent: jest.Mock;
  let getEffectivePermissions: jest.Mock;
  let verify: jest.Mock;
  let resolve: jest.Mock;
  let guard: StationTokenAccessGuard;

  const contextWith = (
    headers: Record<string, string>,
  ): { ctx: ExecutionContext; request: RequestWithStationAccess } => {
    const request = { headers, ip: '203.0.113.9' } as unknown as RequestWithStationAccess;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { ctx, request };
  };

  beforeEach(() => {
    assertVerified = jest.fn().mockResolvedValue(undefined);
    assertCurrent = jest.fn().mockResolvedValue(undefined);
    verify = jest.fn().mockResolvedValue(CLAIMS);
    resolve = jest.fn().mockResolvedValue({ user: STAFF, activeSession: HELD });
    getEffectivePermissions = jest
      .fn()
      .mockResolvedValue([{ key: STATION_TOKEN_ISSUE_PERMISSION, scope: 'ALL' }]);
    const prisma = {
      stationCredential: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cred-1',
          revokedAt: null,
          station: { id: 'st-1', code: 'FRONT', name: 'Front door', tokenEpoch: 0, isActive: true },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    guard = new StationTokenAccessGuard(
      prisma as unknown as PrismaService,
      { get: () => 'p'.repeat(32) } as unknown as ConfigService<Env, true>,
      { verify } as unknown as JwtVerifierService,
      { resolveWithActiveSession: resolve } as unknown as UserProvisioningService,
      { getEffectivePermissions } as unknown as PermissionsService,
      { assertVerified } as unknown as LoginGateService,
      { assertCurrent } as unknown as SingleSessionService,
    );
  });

  it('lets a verified staff sign-in through, and attaches user and sign-in', async () => {
    const { ctx, request } = contextWith({ authorization: 'Bearer t' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(assertVerified).toHaveBeenCalledWith(SESSION, false);
    expect(request.user).toEqual(STAFF);
    expect(request.authSession).toEqual(SESSION);
  });

  it('refuses an unverified staff sign-in with LOGIN_CODE_REQUIRED, before the permission check', async () => {
    assertVerified.mockRejectedValue(
      new DomainException('LOGIN_CODE_REQUIRED', 'Enter the code', HttpStatus.UNAUTHORIZED),
    );
    const { ctx, request } = contextWith({ authorization: 'Bearer t' });
    const caught = await guard.canActivate(ctx).then(
      () => null,
      (error: unknown) => error,
    );
    expect((caught as DomainException).code).toBe('LOGIN_CODE_REQUIRED');
    expect(getEffectivePermissions).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it('still refuses a verified sign-in without the permission', async () => {
    getEffectivePermissions.mockResolvedValue([]);
    const { ctx } = contextWith({ authorization: 'Bearer t' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('answers a token without session_id 401 "Invalid or expired token", never asking the gate', async () => {
    verify.mockRejectedValue(new Error('Invalid token: missing session_id claim'));
    const { ctx, request } = contextWith({ authorization: 'Bearer t' });
    const caught = await guard.canActivate(ctx).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(UnauthorizedException);
    expect((caught as UnauthorizedException).message).toBe('Invalid or expired token');
    expect(assertVerified).not.toHaveBeenCalled();
    expect(request.authSession).toBeUndefined();
  });

  it('lets the under-12 refusal through as itself, like AuthGuard (owner, 2026-10-30)', async () => {
    resolve.mockRejectedValue(
      new DomainException('AGE_REQUIREMENT_NOT_MET', 'Too young', HttpStatus.FORBIDDEN),
    );
    const { ctx } = contextWith({ authorization: 'Bearer t' });
    const caught = await guard.canActivate(ctx).then(
      () => null,
      (error: unknown) => error,
    );
    expect((caught as DomainException).code).toBe('AGE_REQUIREMENT_NOT_MET');
    expect(assertVerified).not.toHaveBeenCalled();
  });

  it('never asks for a code on the X-Station-Key credential path', async () => {
    const { ctx, request } = contextWith({ 'x-station-key': 'k'.repeat(40) });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(assertVerified).not.toHaveBeenCalled();
    expect(request.station?.id).toBe('st-1');
  });

  describe('one device at a time', () => {
    it('asks SingleSessionService about a verified staff sign-in', async () => {
      const { ctx } = contextWith({ authorization: 'Bearer t' });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(assertCurrent).toHaveBeenCalledWith(STAFF.id, HELD, SESSION);
    });

    it('never asks for an unverified sign-in, so it can never claim the account', async () => {
      assertVerified.mockRejectedValue(
        new DomainException('LOGIN_CODE_REQUIRED', 'Enter the code', HttpStatus.UNAUTHORIZED),
      );
      const { ctx } = contextWith({ authorization: 'Bearer t' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(DomainException);
      expect(assertCurrent).not.toHaveBeenCalled();
    });

    it('lets 401 SESSION_REPLACED through untouched, before the permission check', async () => {
      assertCurrent.mockRejectedValue(
        new DomainException('SESSION_REPLACED', 'Signed in elsewhere', HttpStatus.UNAUTHORIZED),
      );
      const { ctx, request } = contextWith({ authorization: 'Bearer t' });
      const caught = await guard.canActivate(ctx).then(
        () => null,
        (error: unknown) => error,
      );
      expect((caught as DomainException).code).toBe('SESSION_REPLACED');
      expect(getEffectivePermissions).not.toHaveBeenCalled();
      expect(request.user).toBeUndefined();
    });

    it('never asks on the X-Station-Key credential path, which has no user', async () => {
      const { ctx } = contextWith({ 'x-station-key': 'k'.repeat(40) });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(assertCurrent).not.toHaveBeenCalled();
    });
  });
});
