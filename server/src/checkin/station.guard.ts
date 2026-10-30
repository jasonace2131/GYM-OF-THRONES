import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import { UserProvisioningService } from '../auth/user-provisioning.service';
import { PermissionsService } from '../rbac/permissions.service';
import { LoginGateService } from '../auth/login-gate.service';
import { SingleSessionService } from '../auth/single-session.service';
import { isAgeRequirementRefusal } from '../auth/minimum-age';
import { authSessionFrom } from '../auth/auth-session';
import type { ActiveSession, AuthSession, AuthUser } from '../auth/auth.types';

/** The only key this guard's staff fallback accepts — §6.14.2, kept as seeded. */
export const STATION_TOKEN_ISSUE_PERMISSION = 'checkin.station_token.issue';

export interface AuthenticatedStation {
  id: string;
  code: string;
  name: string;
  tokenEpoch: number;
  isActive: boolean;
}

export type RequestWithStationAccess = Request & {
  user?: AuthUser;
  authSession?: AuthSession;
  station?: AuthenticatedStation;
};

/**
 * Guards `GET /checkin/station-tokens` and `GET /checkin/station-tokens/head`.
 *
 * §6.2.1's auth line is an OR the standard `AuthGuard` → `PermissionsGuard`
 * pipeline cannot express on one route: `X-Station-Key` (a `StationCredential`,
 * no `User` row at all) OR a Bearer token holding `checkin.station_token.issue`.
 * `PermissionsGuard` itself throws a wiring error if `@Public()` and
 * `@RequirePermission()` land on the same route (see its own doc comment), so
 * this route is `@Public()` and this guard performs BOTH checks by hand,
 * replacing the global pipeline for these two routes only.
 *
 * The credential path populates `req.station` and loads no `User` and calls
 * no permission check at all — "PermissionsGuard is not involved" (§6.2.2) is
 * structural here, not a convention. The staff-preview path populates
 * `req.user` exactly as `AuthGuard` would, then checks the one permission key
 * by hand.
 */
@Injectable()
export class StationTokenAccessGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly jwt: JwtVerifierService,
    private readonly provisioning: UserProvisioningService,
    private readonly permissions: PermissionsService,
    private readonly gate: LoginGateService,
    private readonly singleSession: SingleSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithStationAccess>();
    const stationKey = request.headers['x-station-key'];

    if (typeof stationKey === 'string' && stationKey.length > 0) {
      await this.authenticateCredential(request, stationKey);
      return true;
    }

    await this.authenticateStaff(request);
    return true;
  }

  private async authenticateCredential(
    request: RequestWithStationAccess,
    key: string,
  ): Promise<void> {
    const pepper: string = this.config.get('STATION_CREDENTIAL_PEPPER');
    const keyHash = createHash('sha256')
      .update(key + pepper)
      .digest('hex');

    const credential = await this.prisma.stationCredential.findUnique({
      where: { keyHash },
      include: { station: true },
    });

    if (!credential || credential.revokedAt) {
      // Deliberately the SAME message and status as a missing/expired Bearer
      // token — a probe against this route learns nothing about whether a
      // key it guessed was merely revoked versus never issued.
      throw new UnauthorizedException('Invalid station credential');
    }

    const originIpHash = createHash('sha256')
      .update((request.ip ?? 'unknown') + pepper)
      .digest('hex');

    await this.prisma.stationCredential.update({
      where: { id: credential.id },
      data: { lastUsedAt: new Date(), lastUsedIpHash: originIpHash },
    });

    request.station = {
      id: credential.station.id,
      code: credential.station.code,
      name: credential.station.name,
      tokenEpoch: credential.station.tokenEpoch,
      isActive: credential.station.isActive,
    };
  }

  private async authenticateStaff(request: RequestWithStationAccess): Promise<void> {
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Missing X-Station-Key or Authorization header');
    }

    let user: AuthUser;
    let activeSession: ActiveSession;
    let session: AuthSession;
    try {
      const claims = await this.jwt.verify(token);
      ({ user, activeSession } = await this.provisioning.resolveWithActiveSession(claims));
      session = authSessionFrom(claims);
    } catch (error) {
      // Same doctrine as AuthGuard: the real reason never reaches the client,
      // except the under-12 refusal, which is not a token problem.
      if (isAgeRequirementRefusal(error)) throw error;
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (user.status !== 'ACTIVE' || user.deletedAt) {
      throw new ForbiddenException('Account is not active');
    }

    // The emailed sign-in code — the SAME decision AuthGuard makes, from the
    // same service. This route is @Public() for AuthGuard, so without this a
    // password alone would open the station display's token feed.
    await this.gate.assertVerified(session, false);

    // One device at a time, from the same service AuthGuard asks: a staff
    // display left on a screen stops painting codes once its account signs
    // in elsewhere. The X-Station-Key path has no user and no session.
    await this.singleSession.assertCurrent(user.id, activeSession, session);

    const held = await this.permissions.getEffectivePermissions(user);
    if (!held.some((permission) => permission.key === STATION_TOKEN_ISSUE_PERMISSION)) {
      throw new ForbiddenException(
        `Missing required permission: ${STATION_TOKEN_ISSUE_PERMISSION}`,
      );
    }

    request.user = user;
    request.authSession = session;
  }
}
