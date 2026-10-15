import { Controller, Get, Query } from '@nestjs/common';
import type { DailyCheckIns } from '@got/shared';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { DailyCheckInsQueryDto } from './dto/daily-check-ins-query.dto';
import { CheckInsDailyService } from './check-ins-daily.service';

/**
 * The admin dashboard's attendance trend.
 *
 * `checkin.read` rather than a new key: this is the same data the attendance
 * screen already shows, aggregated. Inventing `report.attendance.read` would
 * add a key to the catalogue that every existing grant would have to be
 * amended to include, for no boundary that `checkin.read` does not already
 * draw. COACH holds `checkin.read` only at OWN scope, and a whole-gym
 * aggregate has no per-member rows to scope — so this route is not offered to
 * them at all, which the dashboard reflects by not rendering the panel.
 *
 * It lives in AdminModule rather than FrontDeskModule deliberately: everything
 * in that module is keyed to *now* and is consumed by the desk console, and a
 * historical aggregate would drag reporting concerns into a module whose whole
 * point is the live counter.
 */
@Controller('admin/check-ins')
export class AdminCheckInsController {
  constructor(private readonly checkInsDaily: CheckInsDailyService) {}

  @Get('daily')
  @RequirePermission('checkin.read')
  async daily(@Query() query: DailyCheckInsQueryDto): Promise<DailyCheckIns> {
    return this.checkInsDaily.daily(query);
  }
}
