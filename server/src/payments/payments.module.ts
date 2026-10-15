import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { ShiftsController } from './shifts.controller';
import { ShiftsService } from './shifts.service';
import { GcashSubmissionsService } from './gcash-submissions.service';
import {
  AdminGcashSubmissionsController,
  MeGcashController,
} from './gcash-submissions.controller';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SUMMARY_TRANSPORT, LoggingSummaryTransport } from './summary-transport';

/**
 * The money module. Shifts land first because `Payment.shiftId` is NOT NULL
 * and stays that way — nothing can record a payment until a drawer can be
 * opened.
 *
 * RbacModule is NOT @Global (only PrismaModule and GymConfigModule are), so it
 * must be imported explicitly for PaymentsService to inject PermissionsService
 * — that is the assertDiscountAllowed dependency. CatalogueModule provides
 * PlansService.
 *
 * `ShiftsService` and `PaymentsService` are exported because MembershipModule's
 * sales (task 12) and holds (task 14) services call `requireOpenShiftId(tx)`
 * and `createInTx` inside their own transactions, and MeModule (task 11) calls
 * `listForMember`. Task 17 adds ReportsController, ReportsService and the
 * SUMMARY_TRANSPORT provider — the latter two exported so
 * MembershipNightlyJob (in MembershipModule, which already imports
 * PaymentsModule) can inject them for the step-6 owner summary.
 */
@Module({
  imports: [RbacModule, CatalogueModule],
  controllers: [
    ShiftsController,
    PaymentsController,
    ReportsController,
    // The member's own GCash claim, and the staff queue that reviews it.
    MeGcashController,
    AdminGcashSubmissionsController,
  ],
  providers: [
    ShiftsService,
    PaymentsService,
    ReportsService,
    GcashSubmissionsService,
    { provide: SUMMARY_TRANSPORT, useClass: LoggingSummaryTransport },
  ],
  exports: [ShiftsService, PaymentsService, ReportsService, SUMMARY_TRANSPORT],
})
export class PaymentsModule {}
