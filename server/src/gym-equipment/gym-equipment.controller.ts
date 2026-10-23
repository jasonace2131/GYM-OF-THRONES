import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import type { GymEquipmentItem } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { GymEquipmentDto, ReorderGymEquipmentDto } from './dto/gym-equipment.dto';
import { GymEquipmentService } from './gym-equipment.service';

/**
 * The gym's equipment list, edited from Admin → Settings (owner, 2026-10-23).
 *
 * Behind `ai.admin.configure` — the key the Settings page already uses for
 * what the AI is told (the assistant's instructions). This list exists only
 * to tell the AI planners what the gym has, so it is the same decision and
 * needs no new key, seed or grant. Rate limits: the default bucket, like the
 * assistant settings beside it.
 */
@Controller('admin/equipment')
export class AdminEquipmentController {
  constructor(private readonly equipment: GymEquipmentService) {}

  @Get()
  @RequirePermission('ai.admin.configure')
  async list(): Promise<GymEquipmentItem[]> {
    return this.equipment.list();
  }

  /** Idempotent: a double-tapped Add must not try to add the row twice. */
  @Post()
  @RequirePermission('ai.admin.configure')
  @Idempotent()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: GymEquipmentDto,
  ): Promise<GymEquipmentItem> {
    return this.equipment.create(dto, user.id, user.role);
  }

  /** Static path before `:id`, so "order" is never read as an id. */
  @Put('order')
  @RequirePermission('ai.admin.configure')
  async reorder(
    @CurrentUser() user: AuthUser,
    @Body() dto: ReorderGymEquipmentDto,
  ): Promise<GymEquipmentItem[]> {
    return this.equipment.reorder(dto.ids, user.id, user.role);
  }

  @Patch(':id')
  @RequirePermission('ai.admin.configure')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GymEquipmentDto,
  ): Promise<GymEquipmentItem> {
    return this.equipment.update(id, dto, user.id, user.role);
  }

  @Delete(':id')
  @RequirePermission('ai.admin.configure')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ removed: true }> {
    await this.equipment.remove(id, user.id, user.role);
    return { removed: true };
  }
}
