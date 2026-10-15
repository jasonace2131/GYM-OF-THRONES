import { SetMetadata, applyDecorators } from '@nestjs/common';

export const REQUIRE_PERMISSION_KEY = 'requirePermission';

/**
 * Staff & Access: the reach a route insists on, when it insists on one.
 *
 * Absent on every route that existed before it, so their behaviour is
 * unchanged. Kept as SEPARATE metadata rather than folding an object into
 * `REQUIRE_PERMISSION_KEY`, because specs across the codebase read that key
 * as a plain string.
 */
export const REQUIRE_PERMISSION_SCOPE_KEY = 'requirePermissionScope';

export interface RequirePermissionOptions {
  /**
   * `ALL`: the caller must hold the key at ALL — an OWN grant is a 403.
   *
   * For a route whose whole point is reaching EVERYBODY (the Super Admin's
   * read-only coaching view), where an OWN grant would otherwise pass the
   * guard and quietly mean something narrower than the route promises.
   */
  scope?: 'ALL';
}

/**
 * Requires the caller to hold this permission key. Runs after AuthGuard.
 *
 * The guard resolves this with Nest's `getAllAndOverride`, so a method-level
 * `@RequirePermission` REPLACES a class-level one rather than being ANDed
 * with it, and exactly one permission key is supported per route.
 */
export const RequirePermission = (
  key: string,
  options: RequirePermissionOptions = {},
): MethodDecorator & ClassDecorator =>
  options.scope === undefined
    ? SetMetadata(REQUIRE_PERMISSION_KEY, key)
    : applyDecorators(
        SetMetadata(REQUIRE_PERMISSION_KEY, key),
        SetMetadata(REQUIRE_PERMISSION_SCOPE_KEY, options.scope),
      );
