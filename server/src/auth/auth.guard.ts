import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { ALLOW_UNVERIFIED_LOGIN_KEY } from './decorators/allow-unverified-login.decorator';
import { JwtVerifierService } from './jwt-verifier.service';
import { UserProvisioningService } from './user-provisioning.service';
import { LoginGateService } from './login-gate.service';
import { authSessionFrom } from './auth-session';
import type { AuthSession, AuthUser } from './auth.types';

/**
 * Authenticates every request: verify the token, resolve the local user,
 * confirm the account is usable, and attach it for @CurrentUser().
 *
 * Registered globally via APP_GUARD, so routes are protected by default and
 * must opt out with @Public() rather than opting in.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtVerifierService,
    private readonly provisioning: UserProvisioningService,
    private readonly gate: LoginGateService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser; authSession?: AuthSession }>();
    const token = this.extractBearerToken(request.headers.authorization);

    let user: AuthUser;
    let session: AuthSession;
    try {
      const claims = await this.jwt.verify(token);
      user = await this.provisioning.resolve(claims);
      session = authSessionFrom(claims);
    } catch (error) {
      // Log the real reason server-side; tell the client only that auth
      // failed. Echoing the verification error back would tell an attacker
      // exactly which check they tripped.
      this.logger.warn(`Token rejected: ${(error as Error).message}`);
      throw new UnauthorizedException('Invalid or expired token');
    }

    // SUSPENDED is deliberately let through here. C1's binding ruling:
    // suspend blocks CHECK-IN ONLY, not portal login — `accessVerdict()`
    // (membership/access-verdict.ts) is what denies a SUSPENDED account at
    // the door, with DenialReason.ACCOUNT_SUSPENDED. This guard's job is
    // narrower: keep out an account that is gone (deletedAt) or permanently
    // closed (DEACTIVATED) — never one that is merely temporarily suspended.
    if (user.status === 'DEACTIVATED' || user.deletedAt) {
      // 403, not 401: the token is perfectly valid, the account is just not
      // usable. A 401 would send the client into a re-login loop for an
      // account that cannot be logged into.
      //
      // Deleted and DEACTIVATED share one branch, one status code and one
      // message deliberately. Splitting them would let anyone with a valid
      // token learn whether a given account had been deleted.
      throw new ForbiddenException('Account is not active');
    }

    // The emailed sign-in code. AFTER the status check, so a closed account
    // hears 403 rather than being asked for a code it cannot use. Only the two
    // /auth/login-code routes are exempt.
    const exempt =
      this.reflector.getAllAndOverride<boolean>(ALLOW_UNVERIFIED_LOGIN_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    await this.gate.assertVerified(session, exempt);

    request.user = user;
    request.authSession = session;
    return true;
  }

  private extractBearerToken(header: string | undefined): string {
    const [scheme, value] = header?.split(' ') ?? [];

    if (scheme !== 'Bearer' || !value) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    return value;
  }
}
