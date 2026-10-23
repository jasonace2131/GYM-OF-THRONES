import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { PermissionScope } from '@prisma/client';
import type { RequestWithPermission } from '../rbac.types';

/**
 * The SCOPE of the grant `PermissionsGuard` matched for this route's
 * `@RequirePermission()` key — `OWN` or `ALL`, widest wins.
 *
 * For a route whose OWN rule is not a `where` fragment `@Scope()` can build:
 * "classes I coach" (class.manage at OWN, owner 2026-10-23) is checked by the
 * service against the class's own `coachId`, so the handler needs only to
 * know which reach the caller holds. Same contract as `@Scope()`: it reads
 * what the guard already resolved, and a route without `@RequirePermission()`
 * is a wiring bug that throws rather than defaulting to either answer.
 */
export function grantedScopeOf(request: RequestWithPermission): PermissionScope {
  if (!request.permission) {
    throw new Error(
      '@GrantedScope() used on a route with no PermissionsGuard-resolved permission — pair it with @RequirePermission()',
    );
  }
  return request.permission.scope;
}

const resolveGrantedScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PermissionScope =>
    grantedScopeOf(ctx.switchToHttp().getRequest<RequestWithPermission>()),
);

export function GrantedScope(): ParameterDecorator {
  return resolveGrantedScope();
}
