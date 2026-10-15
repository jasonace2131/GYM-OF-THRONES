import { Module } from '@nestjs/common';
import { CheckinModule } from '../checkin/checkin.module';
import { ClassesModule } from '../classes/classes.module';
import { MembershipModule } from '../membership/membership.module';
import { PaymentsModule } from '../payments/payments.module';
import { MeController } from './me.controller';
import { CoachingController } from './coaching.controller';
import { CoachProgressController } from './coach-progress.controller';
import { MeCheckInsService } from './me-check-ins.service';
import { CoachingService } from './coaching.service';
import { ProgressService } from './progress.service';

/**
 * The member's own surface, wired over MembershipService and PaymentsService
 * without granting the caller a single permission key. That is the whole design:
 * the identity is hard-coded from request.user, so there is no scope to resolve
 * and no key to get wrong.
 *
 * `CoachingController` is the first exception and says why in its own header:
 * it is about the caller as a COACH rather than as a member, so it carries
 * `coach.read`. The identity is still taken from the token, never a parameter.
 *
 * `CoachProgressController` is the second, and the only route set here that
 * names somebody else: it carries `progress.*` and `@Scope('coachedMember')`
 * on every handler, and says why in its own header.
 */
@Module({
  imports: [MembershipModule, PaymentsModule, CheckinModule, ClassesModule],
  controllers: [MeController, CoachingController, CoachProgressController],
  providers: [MeCheckInsService, ProgressService, CoachingService],
  // Staff & Access: the Super Admin's coaching view (CoachesModule) reads the
  // same caseload and progress services the coach's own dashboard does.
  exports: [ProgressService, CoachingService],
})
export class MeModule {}
