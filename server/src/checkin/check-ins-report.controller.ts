import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { CheckInRecord, DeskDenial, PaginatedData } from '@got/shared';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { CheckInsReportService } from './check-ins-report.service';
import { ListCheckInsQueryDto } from './dto/list-check-ins-query.dto';
import { ListDenialsQueryDto } from './dto/list-denials-query.dto';

/**
 * Routes 53 and 54 — attendance, read.
 *
 * `checkin.read` at ALL, which FRONT_DESK, COACH and ADMIN hold. Deliberately
 * unscoped: this is the report an owner uses to decide whether the grace
 * window is set right and whether a station is misbehaving, and a per-coach
 * slice of it would answer neither question.
 *
 * A member reading their OWN history has routes 13 and 14 under /me, which are
 * keyless and narrower — no `DeskMember`, no fraud signals.
 */
@Controller('check-ins')
export class CheckInsReportController {
  constructor(private readonly report: CheckInsReportService) {}

  @Get()
  @RequirePermission('checkin.read')
  async list(@Query() query: ListCheckInsQueryDto): Promise<PaginatedData<CheckInRecord>> {
    return this.report.list(query);
  }

  @Get(':id')
  @RequirePermission('checkin.read')
  async findOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<CheckInRecord> {
    return this.report.findOne(id);
  }
}

/** Route 55. Its own controller because the path is a sibling, not a child. */
@Controller('check-in-denials')
export class CheckInDenialsReportController {
  constructor(private readonly report: CheckInsReportService) {}

  @Get()
  @RequirePermission('checkin.read')
  async list(@Query() query: ListDenialsQueryDto): Promise<PaginatedData<DeskDenial>> {
    return this.report.listDenials(query);
  }
}
