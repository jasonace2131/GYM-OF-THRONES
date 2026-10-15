import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { PaginatedData } from '@got/shared';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { PlansService } from './plans.service';
import type { AdminPlan, PublicPlan } from './plan.presenter';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { ListPlansQueryDto } from './dto/list-plans-query.dto';

/**
 * Route 5. `@Public()` rather than `plan.read`: the pricing grid is the
 * marketing site's front page and must render before anyone has an account.
 * There is no member data on a Plan row, so there is nothing to scope.
 */
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @Public()
  async list(): Promise<PublicPlan[]> {
    return this.plans.listPublic();
  }
}

/**
 * Routes 6–9. One `@RequirePermission` key per route — the decorator resolves
 * with `getAllAndOverride`, so a method-level key REPLACES a class-level one
 * rather than ANDing with it, and a class-level `plan.read` here would be
 * silently discarded by the three `plan.manage` methods below.
 *
 * Route 6 is `plan.read`, which every seeded role holds at ALL — including
 * CLIENT. That is deliberate and safe: an AdminPlan is the price list plus its
 * archive flag and carries no member data at all.
 */
@Controller('admin/plans')
export class AdminPlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @RequirePermission('plan.read')
  async list(@Query() query: ListPlansQueryDto): Promise<PaginatedData<AdminPlan>> {
    return this.plans.list(query);
  }

  @Post()
  @RequirePermission('plan.manage')
  async create(@Body() dto: CreatePlanDto): Promise<AdminPlan> {
    return this.plans.create(dto);
  }

  @Patch(':id')
  @RequirePermission('plan.manage')
  async update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdatePlanDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AdminPlan> {
    return this.plans.update(id, dto, user);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('plan.manage')
  async archive(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<AdminPlan> {
    return this.plans.archive(id, user);
  }
}
