import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { MembershipImportService, type ImportResult } from './membership-import.service';
import { ExtendAllDto, ImportMembershipsDto } from './dto/import-memberships.dto';

/**
 * Routes 31 and 32. Both are dangerous, both are confirm-gated, both carry
 * @Idempotent() — a half-applied 340-row import re-submitted by a nervous
 * operator is exactly the failure the replay table exists for.
 *
 * One @RequirePermission key per route: `getAllAndOverride` means a method-level
 * decorator REPLACES a class-level one, so nothing may be declared on the class.
 */
@Controller('admin/memberships')
export class AdminMembershipsController {
  constructor(private readonly imports: MembershipImportService) {}

  @Post('import')
  @RequirePermission('membership.import')
  @Idempotent()
  async import(
    @CurrentUser() user: AuthUser,
    @Body() dto: ImportMembershipsDto,
  ): Promise<ImportResult> {
    return this.imports.importMembers(user, dto, new Date());
  }

  @Post('extend')
  @RequirePermission('membership.term.adjust')
  @Idempotent()
  async extend(
    @CurrentUser() user: AuthUser,
    @Body() dto: ExtendAllDto,
  ): Promise<{ affected: number }> {
    return this.imports.extendAll(user, dto, new Date());
  }
}
