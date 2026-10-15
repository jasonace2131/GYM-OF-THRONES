import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CoachingService } from './coaching.service';
import { CoachScheduleQueryDto } from './dto/coach-schedule-query.dto';
import type { CoachMemberRow, CoachSession, CoachSummary } from './coaching.presenter';

/**
 * The coach's own dashboard — Figure 12 of the proposal, and REQ020.
 *
 * `coach.read` rather than no key at all, which is where this differs from the
 * rest of `/me`. The other `/me` routes are about the caller as a MEMBER, and
 * every account has that. These are about the caller as a COACH, which most
 * accounts are not — and a CLIENT hitting them should get a clean 403 rather
 * than three empty panels that look like a broken screen.
 *
 * The key is held at OWN by COACH and at ALL by ADMIN, and the scope is
 * ignored here on purpose: the subject is the caller either way, so OWN and
 * ALL mean the same thing on a route with no id in it. An admin opening this
 * sees their own coaching, which for most admins is empty and correct.
 */
@Controller('me/coaching')
export class CoachingController {
  constructor(private readonly coaching: CoachingService) {}

  @Get('summary')
  @RequirePermission('coach.read')
  async summary(@CurrentUser() user: AuthUser): Promise<CoachSummary> {
    return this.coaching.summary(user.id);
  }

  @Get('schedule')
  @RequirePermission('coach.read')
  async schedule(
    @CurrentUser() user: AuthUser,
    @Query() query: CoachScheduleQueryDto,
  ): Promise<CoachSession[]> {
    return this.coaching.schedule(user.id, query);
  }

  @Get('members')
  @RequirePermission('coach.read')
  async members(@CurrentUser() user: AuthUser): Promise<CoachMemberRow[]> {
    return this.coaching.members(user.id);
  }
}
