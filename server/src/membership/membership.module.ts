import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { PaymentsModule } from '../payments/payments.module';
import { MembershipService } from './membership.service';
import { MembershipAlertsService } from './membership-alerts.service';
import { MembershipSalesService } from './membership-sales.service';
import { MembershipHoldsService } from './membership-holds.service';
import { MembershipLifecycleService } from './membership-lifecycle.service';
import { MembershipImportService } from './membership-import.service';
import { MembershipsController } from './memberships.controller';
import { AdminMembershipsController } from './admin-memberships.controller';
import { AdminJobsController } from './admin-jobs.controller';
import { MembershipNightlyJob } from './membership-nightly.job';
import { DAY_PASS_RESOLVER, WalkInDayPassResolver } from './day-pass.resolver';

/**
 * RbacModule is imported for PermissionsService (the payments-field gate) —
 * it is not @Global, unlike PrismaModule and GymConfigModule.
 *
 * CatalogueModule and PaymentsModule are imported here rather than in each of
 * tasks 12–15: the sales service needs PlansService and PaymentsService.createInTx,
 * and the holds service needs ShiftsService, so wiring them once now keeps four
 * later tasks from each editing this file's imports.
 *
 * DAY_PASS_RESOLVER was bound to the always-false implementation through chunk
 * 1; chunk 2 swapped the useClass to WalkInDayPassResolver and changed nothing
 * else, exactly as that seam was designed for. PrismaModule is @Global, so the
 * new resolver's one dependency needs no import here.
 */
@Module({
  imports: [RbacModule, CatalogueModule, PaymentsModule],
  controllers: [MembershipsController, AdminMembershipsController, AdminJobsController],
  providers: [
    MembershipService,
    MembershipAlertsService,
    MembershipSalesService,
    MembershipHoldsService,
    MembershipLifecycleService,
    MembershipImportService,
    MembershipNightlyJob,
    { provide: DAY_PASS_RESOLVER, useClass: WalkInDayPassResolver },
  ],
  // MembershipSalesService is exported for C2's `POST /members` optional
  // plan assignment ("walk-in signs up and pays" in one submit) — it is the
  // only other consumer of `sell()` outside this module.
  exports: [
    MembershipService,
    MembershipSalesService,
    MembershipHoldsService,
    MembershipNightlyJob,
  ],
})
export class MembershipModule {}
