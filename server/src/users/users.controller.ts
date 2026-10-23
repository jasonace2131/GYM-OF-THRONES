import { Body, Controller, Get, Patch } from '@nestjs/common';
import type { MemberAccess, MyProfile } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PermissionsService } from '../rbac/permissions.service';
import { MyProfileService } from './my-profile.service';
import { MembershipService } from '../membership/membership.service';
import { UpdateMyProfileDto } from './dto/update-my-profile.dto';
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
  /**
   * What the caller may do in the member-only features (Workouts, Ask the
   * Gym, My Progress, My Coach) — see `MemberAccess`. Decided here so the
   * portal never reads a role; the gate itself is the server's.
   */
  memberAccess: MemberAccess;
}

@Controller('me')
export class UsersController {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly profiles: MyProfileService,
    private readonly memberships: MembershipService,
  ) {}

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
    const [permissions, memberAccess] = await Promise.all([
      this.permissions.getEffectivePermissions(user),
      this.memberships.memberAccessFor(user),
    ]);

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
      memberAccess,
    };
  }

  /**
   * The account page's read: email, body metrics and medical notes.
   *
   * Its own route rather than more fields on `GET /me`, which every portal
   * screen fetches: medical notes are only the account page's business.
   * Keyless — no permission key, hard-coded to the caller, like `GET /me`.
   */
  @Get('profile')
  profile(@CurrentUser() user: AuthUser): Promise<MyProfile> {
    return this.profiles.get(user.id);
  }

  /** The account page's save. Only sent fields change; email is not one of them. */
  @Patch('profile')
  updateProfile(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateMyProfileDto,
  ): Promise<MyProfile> {
    return this.profiles.update(user.id, dto);
  }
}
