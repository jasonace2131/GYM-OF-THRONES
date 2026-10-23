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
import type { LoggedSet, WorkoutSessionSummary, WorkoutSessionView } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RequireActiveMembership } from '../membership/require-active-membership.decorator';
import { WorkoutSessionsService } from './workout-sessions.service';
import {
  FinishSessionDto,
  ListSessionsQueryDto,
  LogSetDto,
  PatchSessionDto,
  StartSessionDto,
  startBodyOf,
} from './dto/workout-sessions.dto';

/**
 * The member's workout sessions (feat/workout-sessions).
 *
 * Every route carries `workout.member` — CLIENT at OWN, DEV through its
 * bypass, nobody else — and every route is hard-coded to the caller: the
 * member comes from the token, never from a parameter, and an unscoped
 * session id is the same 404 as one that never existed.
 *
 * The two POSTs are `@Idempotent()` (the client mints the key). The set
 * routes are not: a PUT is an upsert and a DELETE a delete on the
 * (session, exercise, set) key, so the phone's offline queue can replay
 * either as often as it likes.
 *
 * `current` is declared before `:id` so Express never reads it as an id.
 */
@Controller('me/workouts/sessions')
@RequirePermission('workout.member')
export class WorkoutSessionsController {
  constructor(private readonly sessions: WorkoutSessionsService) {}

  /** Start a day. 409 WORKOUT_SESSION_OPEN (with `details.sessionId`) if one is open. */
  @Post()
  @RequirePermission('workout.member')
  @RequireActiveMembership()
  @Idempotent()
  async start(
    @CurrentUser() user: AuthUser,
    @Body() dto: StartSessionDto,
  ): Promise<WorkoutSessionView> {
    return this.sessions.start(user.id, startBodyOf(dto));
  }

  /** Finished summaries, newest first. */
  @Get()
  @RequirePermission('workout.member')
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListSessionsQueryDto,
  ): Promise<WorkoutSessionSummary[]> {
    return this.sessions.list(user.id, query.limit);
  }

  @Get('current')
  @RequirePermission('workout.member')
  async current(@CurrentUser() user: AuthUser): Promise<{ session: WorkoutSessionView | null }> {
    return { session: await this.sessions.current(user.id) };
  }

  @Get(':id')
  @RequirePermission('workout.member')
  async get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WorkoutSessionView> {
    return this.sessions.get(user.id, id);
  }

  @Get(':id/summary')
  @RequirePermission('workout.member')
  async summary(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WorkoutSessionSummary> {
    return this.sessions.summary(user.id, id);
  }

  /** Tick (or re-tick with new numbers). Indexes are checked by the service: 400 WORKOUT_SET_INVALID. */
  @Put(':id/sets/:exerciseIndex/:setIndex')
  @RequirePermission('workout.member')
  @RequireActiveMembership()
  async logSet(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('exerciseIndex') exerciseIndex: string,
    @Param('setIndex') setIndex: string,
    @Body() dto: LogSetDto,
  ): Promise<LoggedSet> {
    return this.sessions.logSet(user.id, id, exerciseIndex, setIndex, {
      weightKg: dto.weightKg,
      reps: dto.reps,
    });
  }

  /** Untick. `{ deleted: false }` when it was not ticked — replay-safe. */
  @Delete(':id/sets/:exerciseIndex/:setIndex')
  @RequirePermission('workout.member')
  @RequireActiveMembership()
  async unlogSet(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('exerciseIndex') exerciseIndex: string,
    @Param('setIndex') setIndex: string,
  ): Promise<{ deleted: boolean }> {
    return this.sessions.unlogSet(user.id, id, exerciseIndex, setIndex);
  }

  /** Needs ≥ 1 ticked set (422). A finished session answers its summary again. */
  @Post(':id/finish')
  @RequirePermission('workout.member')
  @RequireActiveMembership()
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async finish(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FinishSessionDto,
  ): Promise<WorkoutSessionSummary> {
    return this.sessions.finish(user.id, id, { feeling: dto.feeling });
  }

  /** The feeling, on a finished session only. */
  @Patch(':id')
  @RequirePermission('workout.member')
  @RequireActiveMembership()
  async patch(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchSessionDto,
  ): Promise<WorkoutSessionSummary> {
    return this.sessions.patch(user.id, id, { feeling: dto.feeling });
  }

  /** Discard an OPEN workout (its sets go with it). A finished one is 409. */
  @Delete(':id')
  @RequirePermission('workout.member')
  @RequireActiveMembership()
  async discard(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ id: string }> {
    return this.sessions.discard(user.id, id);
  }
}
