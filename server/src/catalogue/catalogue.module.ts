import { Module } from '@nestjs/common';
import { AdminPlansController, PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { PromotionsService } from './promotions.service';
import { PromotionsController } from './promotions.controller';

/**
 * §7.8's layout, not §5.11's `billing/`: chunk 2 is written against
 * `catalogue/`, and two directories for one model is how the import graph
 * forks. Anyone reading §5.11 should treat `billing/` as superseded.
 *
 * `PlansService` is exported because MembershipModule (tasks 12, 14, 15) and
 * PaymentsModule (task 10) all call `requireSellable` inside their own
 * transactions.
 */
@Module({
  controllers: [PlansController, AdminPlansController, PromotionsController],
  providers: [PlansService, PromotionsService],
  exports: [PlansService, PromotionsService],
})
export class CatalogueModule {}
