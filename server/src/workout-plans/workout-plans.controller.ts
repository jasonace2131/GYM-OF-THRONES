import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Prisma } from '@prisma/client';
import type { WorkoutPlanSuggestion, WorkoutPlanView } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { Scope } from '../rbac/decorators/scope.decorator';
import type { ScopedWhere } from '../rbac/scope.util';
import { WorkoutPlansService } from './workout-plans.service';
import { SaveWorkoutPlanDto } from './dto/save-workout-plan.dto';

type MemberScope = ScopedWhere<Prisma.UserWhereInput>;

/**
 * A coach's workout plan for a member they actively coach.
 *
 * Every route names a member, so every route carries `@Scope('coachedMember')`
 * — an ACTIVE assignment to the caller, no self branch — exactly like the
 * progress routes beside it. Everything that is not "a member I coach right
 * now" is one 404.
 */
@Controller('me/coaching/members/:memberId/workout-plan')
export class CoachWorkoutPlanController {
  constructor(private readonly plans: WorkoutPlansService) {}

  @Get()
  @RequirePermission('workout.manage')
  async read(
    @CurrentUser() user: AuthUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Scope('coachedMember') scope: MemberScope,
  ): Promise<{ plan: WorkoutPlanView | null }> {
    return this.plans.readForCoach(user, memberId, scope);
  }

  /** Replaces the member's current plan. Audited (WORKOUT_PLAN_SAVED). */
  @Put()
  @RequirePermission('workout.manage')
  async save(
    @CurrentUser() user: AuthUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Scope('coachedMember') scope: MemberScope,
    @Body() dto: SaveWorkoutPlanDto,
  ): Promise<WorkoutPlanView> {
    return this.plans.save(user, memberId, scope, { summary: dto.summary, days: dto.days });
  }

  /**
   * An AI draft — NOT saved. One Gemini call from the shared quota, so it is
   * throttled well below the assistant's own ten a minute.
   */
  @Post('suggest')
  @RequirePermission('workout.suggest')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async suggest(
    @CurrentUser() user: AuthUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Scope('coachedMember') scope: MemberScope,
  ): Promise<WorkoutPlanSuggestion> {
    return this.plans.suggest(user, memberId, scope);
  }
}

/** The member's own plan — "My workout plan" on their dashboard. */
@Controller('me/workout-plan')
export class MyWorkoutPlanController {
  constructor(private readonly plans: WorkoutPlansService) {}

  @Get()
  @RequirePermission('workout.self')
  async mine(@CurrentUser() user: AuthUser): Promise<{ plan: WorkoutPlanView | null }> {
    return this.plans.readForMember(user.id);
  }
}
