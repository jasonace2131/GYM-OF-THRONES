import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { PermissionScope } from '@prisma/client';
import type { CheckInRecord, CheckInSummary, DeskDenial, PaginatedData } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { GrantedScope } from '../rbac/decorators/granted-scope.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { CheckInsReportService } from './check-ins-report.service';
import { ListCheckInsQueryDto } from './dto/list-check-ins-query.dto';
import { ListDenialsQueryDto } from './dto/list-denials-query.dto';

/**
 * Routes 53 and 54 — attendance, read.
 *
 * `checkin.read`: FRONT_DESK and ADMIN hold it at ALL and read everyone's
 * visits. COACH holds it at OWN and reads only the members assigned to them
 * (feat/attendance-history, 2026-11-09). Before that these routes ignored the
 * scope, and a coach's OWN grant read every member's visits.
 *
 * A member reading their OWN history has routes 13 and 14 under /me, which are
 * keyless and narrower — no `DeskMember`, no fraud signals.
 */
@Controller('check-ins')
export class CheckInsReportController {
  constructor(private readonly report: CheckInsReportService) {}

  @Get()
  @RequirePermission('checkin.read')
  async list(
    @CurrentUser() user: AuthUser,
    @GrantedScope() scope: PermissionScope,
    @Query() query: ListCheckInsQueryDto,
  ): Promise<PaginatedData<CheckInRecord>> {
    return this.report.list(query, { scope, callerId: user.id });
  }

  /**
   * The totals above Attendance → History, for the same filters. Declared
   * before `:id` so "summary" is never parsed as a check-in id.
   */
  @Get('summary')
  @RequirePermission('checkin.read')
  async summary(
    @CurrentUser() user: AuthUser,
    @GrantedScope() scope: PermissionScope,
    @Query() query: ListCheckInsQueryDto,
  ): Promise<CheckInSummary> {
    // Paging is ignored: the totals cover every matching visit, not one page.
    return this.report.summary(query, { scope, callerId: user.id });
  }

  @Get(':id')
  @RequirePermission('checkin.read')
  async findOne(
    @CurrentUser() user: AuthUser,
    @GrantedScope() scope: PermissionScope,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<CheckInRecord> {
    return this.report.findOne(id, { scope, callerId: user.id });
  }
}

/** Route 55. Its own controller because the path is a sibling, not a child. */
@Controller('check-in-denials')
export class CheckInDenialsReportController {
  constructor(private readonly report: CheckInsReportService) {}

  @Get()
  @RequirePermission('checkin.read')
  async list(
    @CurrentUser() user: AuthUser,
    @GrantedScope() scope: PermissionScope,
    @Query() query: ListDenialsQueryDto,
  ): Promise<PaginatedData<DeskDenial>> {
    return this.report.listDenials(query, { scope, callerId: user.id });
  }
}
