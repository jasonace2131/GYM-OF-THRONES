import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CoachProfileView } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { Scope } from '../rbac/decorators/scope.decorator';
import type { ScopedWhere } from '../rbac/scope.util';
import { ProgressService, type CoachMemberProgress } from '../me/progress.service';
import { CoachProfilesService } from './coach-profiles.service';
import { CoachCaseloadService, type AdminCoachCaseload } from './coach-caseload.service';
import { UpdateCoachProfileDto } from './dto/update-coach-profile.dto';

type UserScope = ScopedWhere<Prisma.UserWhereInput>;

/**
 * Reading coach profiles — `coach.read`, which ADMIN holds at ALL and COACH
 * at OWN. At OWN the `user` scope reaches the coach's own row, so a coach
 * reads their own profile (the Coach Dashboard shows it, read-only) and
 * nobody else's.
 *
 * Members never come through here: a CLIENT holds no `coach.read`, and reads
 * their own coach's profile through the keyless `GET /me/coach`.
 */
@Controller('coaches')
export class CoachProfilesController {
  constructor(private readonly profiles: CoachProfilesService) {}

  /** Every live coach's profile in reach — the coaches screen and the assign picker, in one call. */
  @Get('profiles')
  @RequirePermission('coach.read')
  async list(@Scope('user') scope: UserScope): Promise<CoachProfileView[]> {
    return this.profiles.list(scope);
  }

  @Get(':id/profile')
  @RequirePermission('coach.read')
  async get(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Scope('user') scope: UserScope,
  ): Promise<CoachProfileView> {
    return this.profiles.get(id, scope);
  }
}

/**
 * The console's side of coaching: editing a profile, and the Super Admin's
 * read-only coaching view.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BOTH READS INSIST ON ALL, AND ONLY DEV HOLDS `progress.read` AT ALL.
 *
 * `caseload` is `coach.read` at ALL — every ADMIN. `progress` is
 * `progress.read` at ALL, which NO role is granted: COACH holds it at OWN
 * (their assigned members, through `/me/coaching/...`), and ADMIN keeps the
 * owner's "admins do not see progress" rule. The Super Admin reaches it
 * through the DEV bypass. `{ scope: 'ALL' }` is what turns a coach's OWN grant
 * into a 403 here instead of a route that quietly means "your own members".
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Controller('admin')
export class AdminCoachingController {
  constructor(
    private readonly profiles: CoachProfilesService,
    private readonly caseloads: CoachCaseloadService,
    private readonly progress: ProgressService,
  ) {}

  @Put('coaches/:id/profile')
  @RequirePermission('coach.profile.update')
  async updateProfile(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCoachProfileDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CoachProfileView> {
    return this.profiles.update(user, id, {
      specializations: dto.specializations,
      bio: dto.bio ?? null,
    });
  }

  @Get('coaches/:coachId/caseload')
  @RequirePermission('coach.read', { scope: 'ALL' })
  async caseload(
    @Param('coachId', new ParseUUIDPipe({ version: '4' })) coachId: string,
  ): Promise<AdminCoachCaseload> {
    return this.caseloads.caseload(coachId);
  }

  /**
   * Read-only. The same `memberProgress` the assigned coach's drill-down
   * reads, under the `coachedMember` scope — which at ALL is "any live
   * account" — so the Super Admin sees exactly what the coach sees.
   */
  @Get('members/:memberId/progress')
  @RequirePermission('progress.read', { scope: 'ALL' })
  async memberProgress(
    @Param('memberId', new ParseUUIDPipe({ version: '4' })) memberId: string,
    @CurrentUser() user: AuthUser,
    @Scope('coachedMember') scope: UserScope,
  ): Promise<CoachMemberProgress> {
    return this.progress.memberProgress(user, memberId, scope);
  }
}
