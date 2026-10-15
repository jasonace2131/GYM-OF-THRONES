import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type {
  AdjustResponse,
  CoachPlanInWorkouts,
  ExerciseGuideView,
  MemberWorkoutPlanView,
  SwapResponse,
  WorkoutAiQuotaView,
  WorkoutDraftView,
  WorkoutsHome,
} from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { WorkoutDraftService } from './workout-draft.service';
import { MemberWorkoutsService } from './member-workouts.service';
import { ExerciseGuidesService } from './exercise-guides.service';
import {
  AdjustDto,
  CreateDraftDto,
  CreatePlanDto,
  GuideQueryDto,
  PatchPlanDto,
  PutPlanBodyDto,
  SwapDto,
} from './dto/workouts.dto';

/**
 * The member's own AI workout planner (feat/member-workouts).
 *
 * Every route carries `workout.member` — CLIENT at OWN, DEV through its
 * bypass, nobody else — and every route is hard-coded to the caller: the id
 * comes from the token, never from a parameter, so there is no scope to
 * resolve. An unscoped plan id is the same 404 as one that never existed.
 *
 * Every POST is `@Idempotent()` (the client mints the key): a generation, a
 * save, a Swap or an Adjust replayed with the same key returns the first
 * answer and spends nothing twice.
 */
@Controller('me/workouts')
@RequirePermission('workout.member')
export class WorkoutsController {
  constructor(
    private readonly drafts: WorkoutDraftService,
    private readonly plans: MemberWorkoutsService,
    private readonly guides: ExerciseGuidesService,
  ) {}

  @Get()
  @RequirePermission('workout.member')
  async home(@CurrentUser() user: AuthUser): Promise<WorkoutsHome> {
    return this.plans.home(user.id);
  }

  /** Charges one AI action, starts the job, answers 202 at once. */
  @Post('drafts')
  @RequirePermission('workout.member')
  @Idempotent()
  @HttpCode(HttpStatus.ACCEPTED)
  async startDraft(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateDraftDto,
  ): Promise<{ draft: WorkoutDraftView; quota: WorkoutAiQuotaView }> {
    return this.drafts.start(user.id, dto);
  }

  /** The poll target. A RUNNING draft past the stale window comes back FAILED. */
  @Get('draft')
  @RequirePermission('workout.member')
  async draft(@CurrentUser() user: AuthUser): Promise<WorkoutDraftView> {
    return this.drafts.read(user.id);
  }

  /** Discard. A running job's later writes match nothing. No refund. */
  @Delete('draft')
  @RequirePermission('workout.member')
  async cancelDraft(@CurrentUser() user: AuthUser): Promise<{ cancelled: boolean }> {
    return this.drafts.cancel(user.id);
  }

  /** Saves the READY draft as a plan and deletes the draft. */
  @Post('plans')
  @RequirePermission('workout.member')
  @Idempotent()
  async savePlan(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePlanDto,
  ): Promise<MemberWorkoutPlanView> {
    return this.plans.save(user.id, { name: dto.name, makeActive: dto.makeActive });
  }

  @Get('plans/:id')
  @RequirePermission('workout.member')
  async plan(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MemberWorkoutPlanView> {
    return this.plans.get(user.id, id);
  }

  @Patch('plans/:id')
  @RequirePermission('workout.member')
  async patchPlan(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchPlanDto,
  ): Promise<MemberWorkoutPlanView> {
    return this.plans.patch(user.id, id, { name: dto.name, isActive: dto.isActive });
  }

  /** Hand edits and kept Swap/Adjust results. Sets `source = EDITED`. */
  @Put('plans/:id/body')
  @RequirePermission('workout.member')
  async putPlanBody(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PutPlanBodyDto,
  ): Promise<MemberWorkoutPlanView> {
    return this.plans.putBody(user.id, id, dto.plan);
  }

  @Delete('plans/:id')
  @RequirePermission('workout.member')
  async deletePlan(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ id: string }> {
    return this.plans.remove(user.id, id);
  }

  /** Three alternatives for one exercise. One AI action. */
  @Post('plans/:id/swap')
  @RequirePermission('workout.member')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async swap(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SwapDto,
  ): Promise<SwapResponse> {
    return this.plans.swap(user.id, id, { weekday: dto.weekday, index: dto.index });
  }

  /** A rewritten day, same weekday. One AI action. Keep = PUT …/body. */
  @Post('plans/:id/adjust')
  @RequirePermission('workout.member')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async adjust(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustDto,
  ): Promise<AdjustResponse> {
    return this.plans.adjust(user.id, id, {
      weekday: dto.weekday,
      preset: dto.preset,
      request: dto.request,
    });
  }

  /**
   * The coach's plan drives Today again: every AI plan of the member's stops
   * being active (feat/workout-sessions). Idempotent in effect as well as by
   * key. 404 WORKOUT_DAY_UNKNOWN when the coach has saved no plan.
   */
  @Post('coach-plan/use')
  @RequirePermission('workout.member')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async useCoachPlan(@CurrentUser() user: AuthUser): Promise<CoachPlanInWorkouts> {
    return this.plans.useCoachPlan(user.id);
  }

  /**
   * Cached How-to. Free for the member, but a miss is one Gemini call from
   * the shared quota, so it is throttled well below the assistant's own.
   */
  @Get('guides')
  @RequirePermission('workout.member')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async guide(
    @CurrentUser() user: AuthUser,
    @Query() query: GuideQueryDto,
  ): Promise<ExerciseGuideView> {
    return this.guides.guide(user.id, query.exercise);
  }
}
