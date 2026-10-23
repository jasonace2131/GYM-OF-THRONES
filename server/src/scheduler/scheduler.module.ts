import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { PruneEphemeraJob } from './jobs/prune-ephemera.job';
import { AutoCloseVisitsJob } from './jobs/auto-close-visits.job';
import { PruneAnnouncementImagesJob } from './jobs/prune-announcement-images.job';
import { MembershipModule } from '../membership/membership.module';
import { AuthModule } from '../auth/auth.module';
import { EraseDeletedAuthJob } from './jobs/erase-deleted-auth.job';

/**
 * Hosts the registry-driven jobs. AppModule imports this alongside
 * `ScheduleModule.forRoot()`, which is what provides SchedulerRegistry.
 *
 * MembershipModule is imported for MembershipNightlyJob only; the job lives
 * beside the services whose transactions it reuses, so the arithmetic exists
 * once. PruneEphemeraJob is untouched, including its deliberate refusal to
 * delete IdempotencyRecord rows at responseStatus 0.
 *
 * GymConfigService is NOT listed here — it is provided globally by
 * GymConfigModule (imported once, in AppModule), so a second instance here
 * would shadow the one the e2e harness resolves. AutoCloseVisitsJob's other
 * two dependencies, OpeningHoursService and SystemNotificationsService, are
 * global for the same reason.
 */
@Module({
  // AuthModule for EraseDeletedAuthJob's SupabaseAdminService.
  imports: [MembershipModule, AuthModule],
  // PruneAnnouncementImagesJob's storage dependency comes from the global
  // StorageModule, like PrismaService from PrismaModule.
  providers: [
    SchedulerService,
    PruneEphemeraJob,
    AutoCloseVisitsJob,
    PruneAnnouncementImagesJob,
    EraseDeletedAuthJob,
  ],
  exports: [SchedulerService],
})
export class SchedulerModule {}
