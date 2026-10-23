import { Module } from '@nestjs/common';
import { AdminEquipmentController } from './gym-equipment.controller';
import { GymEquipmentService } from './gym-equipment.service';

/**
 * The gym's equipment list (owner, 2026-10-23). Exported so the member
 * planner (WorkoutsModule) and the coach's plan suggester
 * (WorkoutPlansModule) share ONE service — and so one cache, which a save
 * here invalidates. AuditModule and PrismaModule are @Global.
 */
@Module({
  controllers: [AdminEquipmentController],
  providers: [GymEquipmentService],
  exports: [GymEquipmentService],
})
export class GymEquipmentModule {}
