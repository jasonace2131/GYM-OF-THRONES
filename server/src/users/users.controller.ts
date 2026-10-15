import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PermissionsService } from '../rbac/permissions.service';
import type { AuthUser } from '../auth/auth.types';
import type { EffectivePermission } from '../rbac/rbac.types';

interface MeResponse {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  heightCm: number | null;
  weightKg: number | null;
  permissions: readonly EffectivePermission[];
}

@Controller('me')
export class UsersController {
  constructor(private readonly permissions: PermissionsService) {}

  /**
   * The authenticated user's own profile plus effective permissions.
   *
   * Returns plain data — TransformInterceptor wraps it as { success, data }.
   *
   * supabaseId and permissionVersion are internal and deliberately omitted:
   * the first is an identifier for another system, the second is a cache
   * mechanism. Neither is any of the browser's business.
   */
  @Get()
  async me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    const permissions = await this.permissions.getEffectivePermissions(user);

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      status: user.status,
      // Safe here — /me is the caller's own record. These must never appear
      // in any endpoint that lists users to somebody else.
      heightCm: user.heightCm,
      weightKg: user.weightKg,
      permissions,
    };
  }
}
