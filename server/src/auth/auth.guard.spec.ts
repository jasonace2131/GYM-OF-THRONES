import {
  ExecutionContext,
  ForbiddenException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainException } from '../common/exceptions/domain.exception';
import { AuthGuard } from './auth.guard';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { ALLOW_UNVERIFIED_LOGIN_KEY } from './decorators/allow-unverified-login.decorator';
import { JwtVerifierService } from './jwt-verifier.service';
import { UserProvisioningService } from './user-provisioning.service';
import { LoginGateService } from './login-gate.service';
import { SingleSessionService } from './single-session.service';
import type { ActiveSession, AuthSession, AuthUser, SupabaseClaims } from './auth.types';

const CLAIMS: SupabaseClaims = {
  sub: '11111111-1111-1111-1111-111111111111',
  email: 'juan@example.com',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  phone: null,
  heightCm: null,
  weightKg: null,
  dateOfBirth: null,
  sessionId: '99999999-9999-4999-8999-999999999999',
  amr: ['password'],
  signedInAt: new Date('2026-10-30T01:00:00.000Z'),
};

/** This sign-in already holds the account. */
const HELD: ActiveSession = { sessionId: CLAIMS.sessionId, signedInAt: CLAIMS.signedInAt };

const ACTIVE_USER: AuthUser = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  supabaseId: CLAIMS.sub,
  email: CLAIMS.email,
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  role: 'CLIENT',
  status: 'ACTIVE',
  permissionVersion: 0,
  heightCm: null,
  weightKg: null,
  deletedAt: null,
};

function contextWith(headers: Record<string, string>): {
  ctx: ExecutionContext;
  request: { headers: Record<string, string>; user?: AuthUser; authSession?: AuthSession };
} {
  const request: { headers: Record<string, string>; user?: AuthUser; authSession?: AuthSession } = {
    headers,
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, request };
}

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let verify: jest.Mock;
  let resolve: jest.Mock;
  let assertVerified: jest.Mock;
  let assertCurrent: jest.Mock;
  let activeSession: ActiveSession;
  let isPublic: boolean;
  let allowUnverified: boolean | undefined;

  beforeEach(() => {
    isPublic = false;
    allowUnverified = undefined;
    verify = jest.fn().mockResolvedValue(CLAIMS);
    resolve = jest.fn().mockResolvedValue(ACTIVE_USER);
    assertVerified = jest.fn().mockResolvedValue(undefined);
    assertCurrent = jest.fn().mockResolvedValue(undefined);
    activeSession = HELD;

    const reflector = {
      getAllAndOverride: (key: string): boolean | undefined =>
        key === IS_PUBLIC_KEY
          ? isPublic
          : key === ALLOW_UNVERIFIED_LOGIN_KEY
            ? allowUnverified
            : undefined,
    } as unknown as Reflector;
    guard = new AuthGuard(
      reflector,
      { verify } as unknown as JwtVerifierService,
      {
        // `resolve` stays the knob the tests turn; the guard reads the user
        // and the account's current sign-in together.
        resolveWithActiveSession: async (claims: SupabaseClaims) => ({
          user: (await resolve(claims)) as AuthUser,
          activeSession,
        }),
      } as unknown as UserProvisioningService,
      { assertVerified } as unknown as LoginGateService,
      { assertCurrent } as unknown as SingleSessionService,
    );
  });

  it('allows a @Public() route with no token', async () => {
    isPublic = true;
    const { ctx } = contextWith({});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('attaches the resolved user to the request', async () => {
    const { ctx, request } = contextWith({ authorization: 'Bearer good.token.here' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toEqual(ACTIVE_USER);
  });

  it('rejects a missing Authorization header', async () => {
    const { ctx } = contextWith({});
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const { ctx } = contextWith({ authorization: 'Basic abc123' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an invalid token', async () => {
    verify.mockRejectedValue(new Error('signature verification failed'));
    const { ctx } = contextWith({ authorization: 'Bearer bad.token.here' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('allows a suspended user through — suspend blocks check-in only, not portal login', async () => {
    const suspended = { ...ACTIVE_USER, status: 'SUSPENDED' as const };
    resolve.mockResolvedValue(suspended);
    const { ctx, request } = contextWith({ authorization: 'Bearer good.token.here' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toEqual(suspended);
  });

  it('rejects a deactivated user', async () => {
    resolve.mockResolvedValue({ ...ACTIVE_USER, status: 'DEACTIVATED' });
    const { ctx } = contextWith({ authorization: 'Bearer good.token.here' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('rejects a soft-deleted user with the same 403 and the same message', async () => {
    resolve.mockResolvedValue({ ...ACTIVE_USER, deletedAt: new Date('2026-08-01T02:00:00Z') });
    const { ctx } = contextWith({ authorization: 'Bearer good.token.here' });

    // Identical to the DEACTIVATED rejection on purpose: a different status
    // code or message would tell a caller whether an account was deleted or
    // merely deactivated, which is an enumeration difference.
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(ctx)).rejects.toThrow('Account is not active');
  });

  it('does not attach a soft-deleted user to the request', async () => {
    resolve.mockResolvedValue({ ...ACTIVE_USER, deletedAt: new Date('2026-08-01T02:00:00Z') });
    const { ctx, request } = contextWith({ authorization: 'Bearer good.token.here' });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(request.user).toBeUndefined();
  });

  describe('the emailed sign-in code', () => {
    const SESSION: AuthSession = {
      sessionId: CLAIMS.sessionId,
      viaEmailLink: false,
      signedInAt: CLAIMS.signedInAt,
    };

    it('asks the gate about this sign-in, and attaches it as request.authSession', async () => {
      const { ctx, request } = contextWith({ authorization: 'Bearer good.token.here' });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(assertVerified).toHaveBeenCalledWith(SESSION, false);
      expect(request.authSession).toEqual(SESSION);
    });

    it('passes exempt=true on an @AllowUnverifiedLogin() route', async () => {
      allowUnverified = true;
      const { ctx } = contextWith({ authorization: 'Bearer good.token.here' });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(assertVerified).toHaveBeenCalledWith(SESSION, true);
    });

    it('marks a magic-link sign-in as an email link', async () => {
      verify.mockResolvedValue({ ...CLAIMS, amr: ['otp'] });
      const { ctx } = contextWith({ authorization: 'Bearer good.token.here' });
      await guard.canActivate(ctx);
      expect(assertVerified).toHaveBeenCalledWith({ ...SESSION, viaEmailLink: true }, false);
    });

    it('lets the 401 LOGIN_CODE_REQUIRED through untouched, and attaches no user', async () => {
      assertVerified.mockRejectedValue(
        new DomainException('LOGIN_CODE_REQUIRED', 'Enter the code', HttpStatus.UNAUTHORIZED),
      );
      const { ctx, request } = contextWith({ authorization: 'Bearer good.token.here' });
      const caught = await guard.canActivate(ctx).then(
        () => null,
        (error: unknown) => error,
      );
      expect((caught as DomainException).code).toBe('LOGIN_CODE_REQUIRED');
      expect(request.user).toBeUndefined();
    });

    it('answers a deactivated account 403 before asking for a code', async () => {
      resolve.mockResolvedValue({ ...ACTIVE_USER, status: 'DEACTIVATED' });
      const { ctx } = contextWith({ authorization: 'Bearer good.token.here' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
      expect(assertVerified).not.toHaveBeenCalled();
    });

    it('still answers a token without session_id 401 "Invalid or expired token", never asking the gate', async () => {
      verify.mockRejectedValue(new Error('Invalid token: missing session_id claim'));
      const { ctx, request } = contextWith({ authorization: 'Bearer good.token.here' });
      const caught = await guard.canActivate(ctx).then(
        () => null,
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(UnauthorizedException);
      expect((caught as UnauthorizedException).message).toBe('Invalid or expired token');
      expect(assertVerified).not.toHaveBeenCalled();
      expect(request.authSession).toBeUndefined();
    });

    it('still answers a provisioning failure 401 "Invalid or expired token"', async () => {
      resolve.mockRejectedValue(new Error('database down'));
      const { ctx } = contextWith({ authorization: 'Bearer good.token.here' });
      await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid or expired token');
      expect(assertVerified).not.toHaveBeenCalled();
    });

    // Owner, 2026-10-30: provisioning will not create an account for somebody
    // under 12. That is not a token failure, and a 401 would leave the sign-in
    // page asking for a sign-in that can never work.
    it('lets the 403 AGE_REQUIREMENT_NOT_MET through untouched, never asking the gate', async () => {
      resolve.mockRejectedValue(
        new DomainException('AGE_REQUIREMENT_NOT_MET', 'Too young', HttpStatus.FORBIDDEN),
      );
      const { ctx, request } = contextWith({ authorization: 'Bearer good.token.here' });
      const caught = await guard.canActivate(ctx).then(
        () => null,
        (error: unknown) => error,
      );
      expect((caught as DomainException).code).toBe('AGE_REQUIREMENT_NOT_MET');
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(assertVerified).not.toHaveBeenCalled();
      expect(request.user).toBeUndefined();
    });

    it('does not pass any OTHER domain failure from provisioning through', async () => {
      resolve.mockRejectedValue(
        new DomainException('MEMBER_NOT_FOUND', 'secret detail', HttpStatus.NOT_FOUND),
      );
      const { ctx } = contextWith({ authorization: 'Bearer good.token.here' });
      await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid or expired token');
    });

    it('attaches request.authSession on an @AllowUnverifiedLogin() route too', async () => {
      allowUnverified = true;
      const { ctx, request } = contextWith({ authorization: 'Bearer good.token.here' });
      await guard.canActivate(ctx);
      expect(request.user).toEqual(ACTIVE_USER);
      expect(request.authSession).toEqual(SESSION);
    });

    it('never consults the gate on a @Public() route', async () => {
      isPublic = true;
      const { ctx } = contextWith({});
      await guard.canActivate(ctx);
      expect(assertVerified).not.toHaveBeenCalled();
    });
  });

  describe('one device at a time', () => {
    const SESSION: AuthSession = {
      sessionId: CLAIMS.sessionId,
      viaEmailLink: false,
      signedInAt: CLAIMS.signedInAt,
    };

    it('asks SingleSessionService about a verified sign-in, with the row provisioning read', async () => {
      const elsewhere: ActiveSession = {
        sessionId: '88888888-8888-4888-8888-888888888888',
        signedInAt: new Date('2026-10-29T01:00:00.000Z'),
      };
      activeSession = elsewhere;
      const { ctx } = contextWith({ authorization: 'Bearer good.token.here' });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(assertCurrent).toHaveBeenCalledWith(ACTIVE_USER.id, elsewhere, SESSION);
    });

    it('asks only AFTER the emailed code: an unverified sign-in never claims the account', async () => {
      assertVerified.mockRejectedValue(
        new DomainException('LOGIN_CODE_REQUIRED', 'Enter the code', HttpStatus.UNAUTHORIZED),
      );
      const { ctx } = contextWith({ authorization: 'Bearer good.token.here' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(DomainException);
      expect(assertCurrent).not.toHaveBeenCalled();
    });

    it('skips the rule on an @AllowUnverifiedLogin() route, so the code step can finish', async () => {
      allowUnverified = true;
      assertCurrent.mockRejectedValue(
        new DomainException('SESSION_REPLACED', 'Signed in elsewhere', HttpStatus.UNAUTHORIZED),
      );
      const { ctx, request } = contextWith({ authorization: 'Bearer good.token.here' });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(assertCurrent).not.toHaveBeenCalled();
      expect(request.user).toEqual(ACTIVE_USER);
    });

    it('lets the 401 SESSION_REPLACED through untouched, and attaches no user', async () => {
      assertCurrent.mockRejectedValue(
        new DomainException('SESSION_REPLACED', 'Signed in elsewhere', HttpStatus.UNAUTHORIZED),
      );
      const { ctx, request } = contextWith({ authorization: 'Bearer good.token.here' });
      const caught = await guard.canActivate(ctx).then(
        () => null,
        (error: unknown) => error,
      );
      // NOT the generic "Invalid or expired token": the client branches on the code.
      expect(caught).toBeInstanceOf(DomainException);
      expect((caught as DomainException).code).toBe('SESSION_REPLACED');
      expect(request.user).toBeUndefined();
      expect(request.authSession).toBeUndefined();
    });

    it('answers a closed account 403 without consulting the rule', async () => {
      resolve.mockResolvedValue({ ...ACTIVE_USER, status: 'DEACTIVATED' });
      const { ctx } = contextWith({ authorization: 'Bearer good.token.here' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
      expect(assertCurrent).not.toHaveBeenCalled();
    });

    it('never consults the rule on a @Public() route', async () => {
      isPublic = true;
      const { ctx } = contextWith({});
      await guard.canActivate(ctx);
      expect(assertCurrent).not.toHaveBeenCalled();
    });
  });
});
