import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { Scope } from '../rbac/decorators/scope.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import type { ScopedWhere } from '../rbac/scope.util';
import type { AuthUser } from '../auth/auth.types';
import { ProgressService, type CoachMemberProgress } from './progress.service';
import type { MemberGoalDto, MeasurementDto } from './progress.presenter';
import { RecordMeasurementDto, UpdateMeasurementDto } from './dto/record-measurement.dto';
import { CreateGoalDto, UpdateGoalDto } from './dto/goal.dto';

type MemberScope = ScopedWhere<Prisma.UserWhereInput>;

/**
 * A coach recording progress for a member assigned to them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE `/me` CONTROLLER THAT TAKES SOMEBODY ELSE'S ID.
 *
 * It lives under `/me/coaching` because it is part of the coach's own surface
 * (the portal, not the CRM — a coach is not staff, see coaching.presenter.ts).
 * But unlike `CoachingController`, whose subject is always the caller, these
 * routes name a member in the path. That is only safe because every handler
 * carries `@Scope('coachedMember')`, and every service method runs that scope
 * through `memberInScope` before reading or writing a row:
 *
 *   - `coachedMember` at OWN is an ACTIVE assignment to the caller, on a live
 *     account, with NO self branch — not `ownUserWhere`/`ownRowWhere`, which
 *     both include the caller's own rows.
 *   - Everything that is not "a member I coach right now" is the same 404.
 *
 * Keys: `progress.read` / `progress.record`, granted to COACH at OWN and to
 * nobody else. An ADMIN who is assigned as somebody's coach still gets a 403
 * here (D1) — the grant, not the assignment, opens the route. DEV reaches it
 * through its documented bypass at ALL, which the scope still limits to
 * accounts that are not deleted.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every DELETE answers 200 with `{ id }`, never 204: `apiFetch` always reads a
 * JSON body, and a 204 made the member page's goal "Remove" delete the goal
 * and then throw INVALID_RESPONSE, leaving the list stale.
 */
@Controller('me/coaching/members/:memberId')
export class CoachProgressController {
  constructor(private readonly progress: ProgressService) {}

  @Get('progress')
  @RequirePermission('progress.read')
  async read(
    @CurrentUser() user: AuthUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Scope('coachedMember') scope: MemberScope,
  ): Promise<CoachMemberProgress> {
    return this.progress.memberProgress(user, memberId, scope);
  }

  /**
   * Not `@Idempotent()`: the day's row is its own key. A double-tap upserts
   * the same day with the same values, which is exactly what a replay would
   * have returned.
   */
  @Post('measurements')
  @RequirePermission('progress.record')
  async recordMeasurement(
    @CurrentUser() user: AuthUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Scope('coachedMember') scope: MemberScope,
    @Body() dto: RecordMeasurementDto,
  ): Promise<MeasurementDto> {
    return this.progress.recordMeasurement(user, memberId, scope, dto);
  }

  @Patch('measurements/:id')
  @RequirePermission('progress.record')
  async updateMeasurement(
    @CurrentUser() user: AuthUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Scope('coachedMember') scope: MemberScope,
    @Body() dto: UpdateMeasurementDto,
  ): Promise<MeasurementDto> {
    return this.progress.updateMeasurement(user, memberId, scope, id, dto);
  }

  @Delete('measurements/:id')
  @RequirePermission('progress.record')
  async removeMeasurement(
    @CurrentUser() user: AuthUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Scope('coachedMember') scope: MemberScope,
  ): Promise<{ id: string }> {
    return this.progress.removeMeasurement(user, memberId, scope, id);
  }

  /**
   * `@Idempotent()`: unlike a measurement, a goal has no natural key, so a
   * double-tapped "Add goal" would otherwise create two. `apiFetch` sends the
   * Idempotency-Key on every POST.
   */
  @Post('goals')
  @Idempotent()
  @RequirePermission('progress.record')
  async createGoal(
    @CurrentUser() user: AuthUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Scope('coachedMember') scope: MemberScope,
    @Body() dto: CreateGoalDto,
  ): Promise<MemberGoalDto> {
    return this.progress.createGoal(user, memberId, scope, dto);
  }

  @Patch('goals/:id')
  @RequirePermission('progress.record')
  async updateGoal(
    @CurrentUser() user: AuthUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Scope('coachedMember') scope: MemberScope,
    @Body() dto: UpdateGoalDto,
  ): Promise<MemberGoalDto> {
    return this.progress.updateGoal(user, memberId, scope, id, dto);
  }

  @Delete('goals/:id')
  @RequirePermission('progress.record')
  async removeGoal(
    @CurrentUser() user: AuthUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Scope('coachedMember') scope: MemberScope,
  ): Promise<{ id: string }> {
    return this.progress.removeGoal(user, memberId, scope, id);
  }
}
