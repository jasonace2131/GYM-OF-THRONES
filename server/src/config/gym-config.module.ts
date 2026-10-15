import { Global, Module } from '@nestjs/common';
import { AdminHoursController, ConfigController } from './config.controller';
import { GymConfigService } from './gym.config';
import { OpeningHoursService } from './opening-hours.service';

/**
 * Global so feature modules can inject GymConfigService without importing
 * this module explicitly — same pattern as PrismaModule.
 *
 * Task 5 provided GymConfigService directly on AppModule.providers, which is
 * enough for the e2e harness's `app.get(GymConfigService, { strict: false })`
 * (a whole-container lookup) but NOT enough for ordinary constructor
 * injection from a sibling feature module: Nest only resolves a constructor
 * dependency from the module's own providers or from modules it imports (or
 * a @Global module), never from the root module's private provider list.
 * Task 14 is the first feature module (SchedulerModule) to inject
 * GymConfigService via its constructor, which is what surfaced the gap.
 *
 * Registered once, here, as the single source of the singleton — AppModule
 * no longer lists GymConfigService in its own `providers`, so there is
 * exactly one instance app-wide and the e2e harness still resolves it.
 */
@Global()
@Module({
  // The controller lives here rather than in a module of its own: it has one
  // dependency, and that dependency is this module's whole reason to exist.
  controllers: [ConfigController, AdminHoursController],
  // OpeningHoursService lives here too, for the same reason: it is the
  // editable half of the same configuration, it reads GymConfigService as its
  // fallback, and being @Global means the door gate can inject it without
  // CheckinModule importing a config module.
  providers: [GymConfigService, OpeningHoursService],
  exports: [GymConfigService, OpeningHoursService],
})
export class GymConfigModule {}
