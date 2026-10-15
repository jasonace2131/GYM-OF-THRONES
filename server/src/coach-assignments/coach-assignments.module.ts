import { Module } from '@nestjs/common';
import { CoachAssignmentsController } from './coach-assignments.controller';
import { CoachAssignmentsService } from './coach-assignments.service';

/**
 * The first scoped feature module. `PermissionsGuard` (which populates
 * `request.permission` for `@Scope()`) is registered globally in
 * `AppModule`, so this module does not need to import `RbacModule` itself.
 */
@Module({
  controllers: [CoachAssignmentsController],
  providers: [CoachAssignmentsService],
  exports: [CoachAssignmentsService],
})
export class CoachAssignmentsModule {}
