import { Module } from '@nestjs/common';
import { GeminiModule } from '../assistant/gemini.module';
import { GymEquipmentModule } from '../gym-equipment/gym-equipment.module';
import { ProgressService } from '../me/progress.service';
import { MeCheckInsService } from '../me/me-check-ins.service';
import { CoachWorkoutPlanController, MyWorkoutPlanController } from './workout-plans.controller';
import { WorkoutPlansService } from './workout-plans.service';

/**
 * Workout plans (feat/coach-tools).
 *
 * Reads the member through the SAME services the progress and attendance
 * screens use (stateless, so provided here as the assistant does with
 * MeCheckInsService), and reaches Gemini through the one shared gateway, so a
 * plan suggestion spends from the same quota ledger as members' questions.
 */
@Module({
  imports: [GeminiModule, GymEquipmentModule],
  controllers: [CoachWorkoutPlanController, MyWorkoutPlanController],
  providers: [WorkoutPlansService, ProgressService, MeCheckInsService],
  // The member's Workouts page shows the coach's plan and starts sessions
  // from it (feat/workout-sessions) through this same read.
  exports: [WorkoutPlansService],
})
export class WorkoutPlansModule {}
