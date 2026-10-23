import { Module } from '@nestjs/common';
import { MembershipModule } from '../membership/membership.module';
import { GeminiModule } from '../assistant/gemini.module';
import { ClassesModule } from '../classes/classes.module';
import { ProgressService } from '../me/progress.service';
import { MeCheckInsService } from '../me/me-check-ins.service';
import { WorkoutPlansModule } from '../workout-plans/workout-plans.module';
import { GymEquipmentModule } from '../gym-equipment/gym-equipment.module';
import { WorkoutsController } from './workouts.controller';
import { WorkoutSessionsController } from './workout-sessions.controller';
import { WorkoutQuotaService } from './workout-quota.service';
import { WorkoutDraftService } from './workout-draft.service';
import { MemberWorkoutsService } from './member-workouts.service';
import { ExerciseGuidesService } from './exercise-guides.service';
import { WorkoutSessionsService } from './workout-sessions.service';

/**
 * The member workout planner (feat/member-workouts) and the member's
 * workout sessions (feat/workout-sessions).
 *
 * Reads the member through the SAME services the /me screens use — progress
 * and attendance (stateless, so provided here as the assistant and the
 * coach's plan suggester do), bookings from ClassesModule — and reaches
 * Gemini through the one shared gateway, so a member's generation spends
 * from the same quota ledger as everything else. The coach's plan comes
 * through WorkoutPlansModule's own member read, so its schema check and its
 * "a gone coach has no name" rule stay in one place. PrismaModule and
 * GymConfigModule (with OpeningHoursService) are @Global.
 */
@Module({
  // MembershipModule: the How-to miss needs an active membership (owner, 2026-10-17).
  imports: [GeminiModule, ClassesModule, WorkoutPlansModule, GymEquipmentModule, MembershipModule],
  controllers: [WorkoutsController, WorkoutSessionsController],
  providers: [
    WorkoutQuotaService,
    WorkoutDraftService,
    MemberWorkoutsService,
    ExerciseGuidesService,
    WorkoutSessionsService,
    ProgressService,
    MeCheckInsService,
  ],
})
export class WorkoutsModule {}
