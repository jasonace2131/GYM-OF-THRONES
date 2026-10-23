import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../auth/auth.types';
import { DomainException } from '../common/exceptions/domain.exception';
import { MembershipService } from './membership.service';
import { isMembershipGated, MEMBERSHIP_REQUIRED_MESSAGE } from './membership-gate';
import { REQUIRE_ACTIVE_MEMBERSHIP_KEY } from './require-active-membership.decorator';

/**
 * Enforces `@RequireActiveMembership()`. Registered globally after
 * PermissionsGuard, so a caller without the feature's permission still gets
 * that 403 first; a route without the decorator is unaffected.
 *
 * The gate is the SERVER's — the portal's locked page and read-only notice
 * only explain it. Hiding a button is not a security control.
 */
@Injectable()
export class ActiveMembershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly memberships: MembershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(
      REQUIRE_ACTIVE_MEMBERSHIP_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required !== true) return true;

    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user) {
      throw new Error('@RequireActiveMembership() used on a route that AuthGuard did not populate');
    }
    if (!isMembershipGated(user.role)) return true;

    if (await this.memberships.hasActiveMembership(user.id)) return true;
    throw new DomainException(
      'MEMBERSHIP_REQUIRED',
      MEMBERSHIP_REQUIRED_MESSAGE,
      HttpStatus.FORBIDDEN,
    );
  }
}
