import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PaginatedData } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { Scope } from '../rbac/decorators/scope.decorator';
import type { ScopedWhere } from '../rbac/scope.util';
import type { AuthUser } from '../auth/auth.types';
import { CoachAssignmentsService } from './coach-assignments.service';
import type { CoachAssignmentView } from './coach-assignment.presenter';
import { ListCoachAssignmentsQueryDto } from './dto/list-coach-assignments-query.dto';
import { CreateCoachAssignmentDto } from './dto/create-coach-assignment.dto';

type AssignmentScope = ScopedWhere<Prisma.CoachAssignmentWhereInput>;

/**
 * One permission key per route — `@RequirePermission` is resolved with
 * `getAllAndOverride`, so a method-level decorator REPLACES a class-level one
 * rather than ANDing with it. There is no composite-key route in this design.
 *
 * Scoped handlers take `@Scope('coachAssignment')` rather than calling
 * `permissions.scopeFilter(user, '<key>', 'coachAssignment')` by hand — the
 * permission key would otherwise appear twice per route (once in
 * `@RequirePermission`, once spelled again at the call site), and if the two
 * ever diverged a caller holding both permissions would silently get the
 * WRONG one's scope. `@Scope()` reads the scope `PermissionsGuard` already
 * resolved against the SAME key, so the key is written exactly once.
 */
@Controller('coach-assignments')
export class CoachAssignmentsController {
  constructor(private readonly assignments: CoachAssignmentsService) {}

  @Get()
  @RequirePermission('coach.read')
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListCoachAssignmentsQueryDto,
    @Scope('coachAssignment') scope: AssignmentScope,
  ): Promise<PaginatedData<CoachAssignmentView>> {
    return this.assignments.list(user, query, scope);
  }

  @Get(':id')
  @RequirePermission('coach.read')
  async findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Scope('coachAssignment') scope: AssignmentScope,
  ): Promise<CoachAssignmentView> {
    return this.assignments.findOne(id, scope);
  }

  @Post()
  @RequirePermission('coach.assign')
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCoachAssignmentDto,
  ): Promise<CoachAssignmentView> {
    return this.assignments.create(user.id, dto);
  }

  @Delete(':id')
  @RequirePermission('coach.update')
  async end(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Scope('coachAssignment') scope: AssignmentScope,
  ): Promise<CoachAssignmentView> {
    return this.assignments.end(user.id, id, scope);
  }
}
