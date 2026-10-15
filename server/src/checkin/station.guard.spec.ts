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
import type { AuthUser, SupabaseClaims } from '../auth/auth.types';
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
};

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
  let getEffectivePermissions: jest.Mock;
  let verify: jest.Mock;
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
    verify = jest.fn().mockResolvedValue(CLAIMS);
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
      { resolve: jest.fn().mockResolvedValue(STAFF) } as unknown as UserProvisioningService,
      { getEffectivePermissions } as unknown as PermissionsService,
      { assertVerified } as unknown as LoginGateService,
    );
  });

  it('lets a verified staff sign-in through, and attaches user and sign-in', async () => {
    const { ctx, request } = contextWith({ authorization: 'Bearer t' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(assertVerified).toHaveBeenCalledWith(
      { sessionId: CLAIMS.sessionId, viaEmailLink: false },
      false,
    );
    expect(request.user).toEqual(STAFF);
    expect(request.authSession).toEqual({ sessionId: CLAIMS.sessionId, viaEmailLink: false });
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

  it('never asks for a code on the X-Station-Key credential path', async () => {
    const { ctx, request } = contextWith({ 'x-station-key': 'k'.repeat(40) });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(assertVerified).not.toHaveBeenCalled();
    expect(request.station?.id).toBe('st-1');
  });
});
