import { Module } from '@nestjs/common';
import { MeModule } from '../me/me.module';
import { AdminCoachingController, CoachProfilesController } from './coaches.controller';
import { CoachProfilesService } from './coach-profiles.service';
import { CoachCaseloadService } from './coach-caseload.service';

/**
 * Staff & Access: coach profiles and the Super Admin's coaching view.
 *
 * MeModule for `CoachingService` (the caseload rows) and `ProgressService`
 * (a member's progress): the console reads the SAME services the coach's own
 * dashboard does, so the two can never disagree. PrismaModule and AuditModule
 * are @Global.
 */
@Module({
  imports: [MeModule],
  controllers: [CoachProfilesController, AdminCoachingController],
  providers: [CoachProfilesService, CoachCaseloadService],
})
export class CoachesModule {}
