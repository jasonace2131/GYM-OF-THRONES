import { Body, Controller, Get, Put } from '@nestjs/common';
import type { PublicGymConfig } from '@got/shared';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { GymConfigService } from './gym.config';
import { OpeningHoursService, type DayHours } from './opening-hours.service';
import { ReplaceOpeningHoursDto } from './dto/opening-hours.dto';
import { toPublicGymConfig } from './public-config.presenter';

/**
 * Route 1 — `GET /config`.
 *
 * `@Public()` because the landing page renders opening hours before anyone has
 * an account, and the login screen needs the time zone to format anything at
 * all. Requiring a token here would mean the marketing site could not say when
 * the gym opens.
 *
 * Reads only from `GymConfigService`, which by construction holds no secret,
 * and then narrows again through the presenter. Two gates, because the cost of
 * getting this one wrong is a public disclosure rather than a broken screen.
 */
@Public()
@Controller('config')
export class ConfigController {
  constructor(
    private readonly gym: GymConfigService,
    private readonly openingHours: OpeningHoursService,
  ) {}

  @Get()
  get(): PublicGymConfig {
    return toPublicGymConfig(this.gym);
  }

  /**
   * The week's real hours, for the marketing site.
   *
   * Public for the same reason `/config` is: the landing page states opening
   * hours to people who have no account. It used to state them from a
   * hardcoded string that disagreed with the door by an hour.
   */
  @Get('hours')
  async hours(): Promise<DayHours[]> {
    return this.openingHours.week();
  }
}

/**
 * Editing the hours. Separate controller because `@Public()` is class-level
 * above, and `PermissionsGuard` throws on a route carrying both.
 *
 * Behind `plan.manage` — the same key as the price list. Both are "what the
 * gym sells and when", both are owner decisions, and a key of its own would
 * be one nobody ever grants separately.
 */
@Controller('admin/hours')
export class AdminHoursController {
  constructor(private readonly openingHours: OpeningHoursService) {}

  @Get()
  @RequirePermission('plan.read')
  async list(): Promise<DayHours[]> {
    return this.openingHours.week();
  }

  /**
   * PUT, not PATCH: the whole week is replaced, so the screen and the
   * database cannot end up half-agreeing.
   */
  @Put()
  @RequirePermission('plan.manage')
  async replace(
    @CurrentUser() user: AuthUser,
    @Body() dto: ReplaceOpeningHoursDto,
  ): Promise<DayHours[]> {
    return this.openingHours.replace(dto.days, user.id, user.role);
  }
}
