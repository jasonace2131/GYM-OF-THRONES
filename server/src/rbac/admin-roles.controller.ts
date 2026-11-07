import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from './decorators/require-permission.decorator';
import { ResetRoleAccessDto, RoleParamDto, SaveRoleAccessDto } from './dto/role-access.dto';
import { RoleAccessService, type RoleAccessView } from './role-access.service';

/**
 * Staff & Access → "Edit role access" (feat/role-access-editor, owner 2026-11-07).
 *
 * The read-only "What each role can do" table keeps its own endpoints
 * (`GET /admin/permissions`, `GET /admin/permissions/roles`); this is the
 * separate editor beside it.
 *
 * Writes need `role.permissions.update` — a key ADMIN has held since the RBAC
 * work shipped, with nothing behind it until now. WHICH roles a caller may
 * edit is `@got/shared`'s `canEditRoleAccess`: an Admin edits Front desk and
 * Coach, the Super Admin also Admin and Member, nobody the Super Admin.
 */
@Controller('admin/roles')
export class AdminRolesController {
  constructor(private readonly access: RoleAccessService) {}

  /** Every role's live grants and defaults, and which ones this caller may edit. */
  @Get('permissions')
  @RequirePermission('permission.read')
  view(@CurrentUser() user: AuthUser): Promise<RoleAccessView> {
    return this.access.view(user);
  }

  /** Replace the role's whole set. 422 names the rule a set breaks. */
  @Put(':role/permissions')
  @RequirePermission('role.permissions.update')
  save(
    @CurrentUser() user: AuthUser,
    @Param() params: RoleParamDto,
    @Body() dto: SaveRoleAccessDto,
  ): Promise<RoleAccessView> {
    return this.access.save(user, params.role, {
      grants: dto.grants.map((grant) => ({ key: grant.key, scope: grant.scope })),
      reason: dto.reason,
      confirm: dto.confirm,
    });
  }

  /** Clear the gym's changes for one role: back to what the code gives it. */
  @Post(':role/permissions/reset')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('role.permissions.update')
  reset(
    @CurrentUser() user: AuthUser,
    @Param() params: RoleParamDto,
    @Body() dto: ResetRoleAccessDto,
  ): Promise<RoleAccessView> {
    return this.access.reset(user, params.role, dto.reason);
  }
}
