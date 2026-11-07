import { Module } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { PermissionsGuard } from './permissions.guard';
import { AdminPermissionsController } from './admin-permissions.controller';
import { AdminRolesController } from './admin-roles.controller';
import { RoleAccessService } from './role-access.service';

@Module({
  controllers: [AdminPermissionsController, AdminRolesController],
  providers: [PermissionsService, PermissionsGuard, RoleAccessService],
  exports: [PermissionsService, PermissionsGuard],
})
export class RbacModule {}
