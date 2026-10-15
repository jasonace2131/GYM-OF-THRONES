import { Module } from '@nestjs/common';
import { CheckinModule } from '../checkin/checkin.module';
import { ClassesModule } from '../classes/classes.module';
import { FrontDeskController } from './front-desk.controller';
import { FrontDeskService } from './front-desk.service';
import { DeskCheckInService } from './desk-check-in.service';
import { WalkInService } from './walk-in.service';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { PaymentsModule } from '../payments/payments.module';

/**
 * The front-desk console's own surface.
 *
 * Separate from `CheckinModule` on purpose: that module owns the WRITE path
 * and the station token, and this one owns what a staff PC in a public lobby
 * is allowed to see. Keeping the privacy boundary (`DeskMember`) in its own
 * module makes "who may widen this projection" a code-review question about
 * one directory rather than a convention spread across the attendance code.
 *
 * `CheckinModule` is imported for `DeskFeedService` — the after-commit publish
 * seam the SSE route subscribes to. The dependency runs one way: the write
 * path publishes and knows nothing about who is listening, which is what lets
 * the console be restarted, replaced or simply absent without a check-in ever
 * failing because of it.
 */
@Module({
  imports: [CheckinModule, CatalogueModule, PaymentsModule, ClassesModule],
  controllers: [FrontDeskController],
  providers: [FrontDeskService, DeskCheckInService, WalkInService],
  exports: [FrontDeskService, DeskCheckInService, WalkInService],
})
export class FrontDeskModule {}
