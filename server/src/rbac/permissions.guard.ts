import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import {
  REQUIRE_PERMISSION_KEY,
  REQUIRE_PERMISSION_SCOPE_KEY,
} from './decorators/require-permission.decorator';
import { PermissionsService } from './permissions.service';
import type { RequestWithPermission } from './rbac.types';

/**
 * Enforces `@RequirePermission()`. Registered globally as the second
 * APP_GUARD, after AuthGuard — a route with no requirement is unaffected.
 *
 * `@Public()` wins over `@RequirePermission()`: an unauthenticated request
 * has no `request.user` to check against, so the permission could never be
 * evaluated. Rather than let that combination silently serve a gated
 * handler to anyone, both metadata keys are read up front and having both
 * on the same route throws as a configuration error at request time.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredKey = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic && requiredKey) {
      throw new Error(
        `@Public() and @RequirePermission('${requiredKey}') on the same route — remove one`,
      );
    }
    if (isPublic || !requiredKey) return true;

    const request = context.switchToHttp().getRequest<RequestWithPermission>();
    if (!request.user) {
      throw new Error('@RequirePermission() used on a route that AuthGuard did not populate');
    }

    // Staff & Access: a route may insist on ALL. Absent on every older route.
    const requiredScope = this.reflector.getAllAndOverride<'ALL' | undefined>(
      REQUIRE_PERMISSION_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );

    const held = await this.permissions.getEffectivePermissions(request.user);
    const matches = held.filter(
      (permission) =>
        permission.key === requiredKey && (requiredScope !== 'ALL' || permission.scope === 'ALL'),
    );
    if (matches.length === 0) {
      throw new ForbiddenException(
        requiredScope === 'ALL'
          ? `Missing required permission: ${requiredKey} at ALL`
          : `Missing required permission: ${requiredKey}`,
      );
    }

    // Widest wins, matching PermissionsService.resolveScope — the handler must
    // never see a narrower grant than the caller actually holds.
    request.permission = matches.find((permission) => permission.scope === 'ALL') ?? matches[0];

    return true;
  }
}
