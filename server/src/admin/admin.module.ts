import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { AdminStationsController } from './stations.controller';
import { StationsService } from './stations.service';
import { AdminCheckInsController } from './check-ins-daily.controller';
import { CheckInsDailyService } from './check-ins-daily.service';

/**
 * ADMIN-only operational surfaces that belong to no single feature module.
 *
 * Stations live here rather than in `CheckinModule` on purpose: that module
 * owns the check-in write path, which must keep working while somebody is
 * disabling a tablet, and mixing an incident surface into it would put
 * `station.manage` beside `checkin.self` in one dependency graph.
 */
@Module({
  imports: [RbacModule],
  controllers: [AdminStationsController, AdminCheckInsController],
  providers: [StationsService, CheckInsDailyService],
  exports: [StationsService],
})
export class AdminModule {}
