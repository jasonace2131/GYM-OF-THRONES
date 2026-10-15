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
import type { Promotion } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { gymToday, toDateColumn } from '../common/time/gym-time';
import { PlansService } from './plans.service';
import { PromotionsService, type PromotionQuote } from './promotions.service';
import { CreatePromotionDto, UpdatePromotionDto } from './dto/promotion.dto';

/** Dates leave as civil-date strings, money as integer centavos. */
interface PromotionView {
  id: string;
  code: string;
  label: string;
  kind: string;
  value: number;
  startsOn: string;
  endsOn: string;
  maxRedemptions: number | null;
  redeemedCount: number;
  planCodes: string[];
  isActive: boolean;
}

function toView(row: Promotion): PromotionView {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    kind: row.kind,
    value: row.value,
    // `@db.Date` comes back at UTC midnight; this slice is the sanctioned form
    // for those columns and only for those columns.
    startsOn: row.startsOn.toISOString().slice(0, 10),
    endsOn: row.endsOn.toISOString().slice(0, 10),
    maxRedemptions: row.maxRedemptions,
    redeemedCount: row.redeemedCount,
    planCodes: row.planCodes,
    isActive: row.isActive,
  };
}

/**
 * Promotions live under `plan.manage`, not a key of their own.
 *
 * A promo IS a price change with an expiry date — whoever may edit the price
 * list may run a sale on it, and inventing `promotion.manage` would mean a
 * grant table where an operator can halve a price for a month but not change
 * it permanently, which is a distinction nobody at this gym would want to
 * maintain.
 */
@Controller('admin/promotions')
export class PromotionsController {
  constructor(
    private readonly promotions: PromotionsService,
    private readonly plans: PlansService,
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
  ) {}

  @Get()
  @RequirePermission('plan.read')
  async list(@Query('includeInactive') includeInactive?: string): Promise<PromotionView[]> {
    const rows = await this.prisma.promotion.findMany({
      where: includeInactive === 'true' ? {} : { isActive: true },
      orderBy: [{ isActive: 'desc' }, { endsOn: 'desc' }],
      take: 100,
    });
    return rows.map(toView);
  }

  @Post()
  @RequirePermission('plan.manage')
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePromotionDto,
  ): Promise<PromotionView> {
    const row = await this.prisma.promotion.create({
      data: {
        code: dto.code,
        label: dto.label,
        kind: dto.kind,
        value: dto.value,
        startsOn: toDateColumn(dto.startsOn),
        endsOn: toDateColumn(dto.endsOn),
        maxRedemptions: dto.maxRedemptions ?? null,
        planCodes: dto.planCodes ?? [],
        createdById: user.id,
      },
    });
    return toView(row);
  }

  @Patch(':id')
  @RequirePermission('plan.manage')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromotionDto,
  ): Promise<PromotionView> {
    const row = await this.prisma.promotion.update({
      where: { id },
      data: {
        ...(dto.label === undefined ? {} : { label: dto.label }),
        ...(dto.value === undefined ? {} : { value: dto.value }),
        ...(dto.startsOn === undefined ? {} : { startsOn: toDateColumn(dto.startsOn) }),
        ...(dto.endsOn === undefined ? {} : { endsOn: toDateColumn(dto.endsOn) }),
        ...(dto.maxRedemptions === undefined ? {} : { maxRedemptions: dto.maxRedemptions }),
        ...(dto.planCodes === undefined ? {} : { planCodes: dto.planCodes }),
        ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
      },
    });
    return toView(row);
  }

  /**
   * Price a code before taking any money.
   *
   * Behind `membership.sell` rather than `plan.manage`: the person who needs
   * this is the one ringing the sale, not the one who created the campaign.
   *
   * Quoting does NOT consume a redemption — an abandoned sale must not cost
   * the gym a promo slot, and a member asking "how much with this code" at
   * the counter is the normal case, not the exception.
   */
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('membership.sell')
  async quote(
    @Body() body: { code: string; planCode: string },
  ): Promise<PromotionQuote & { netCentavos: number }> {
    const plan = await this.plans.requireSellable(this.prisma, body.planCode);
    const quote = await this.promotions.quote(
      body.code,
      { code: plan.code, kind: plan.kind, priceCentavos: plan.priceCentavos },
      gymToday(new Date(), this.gym.timeZone),
    );

    return {
      ...quote,
      // What the member will actually hand over, so the counter can read it
      // out. The authoritative figure is still computed at sale time.
      netCentavos: plan.priceCentavos - quote.discountCentavos,
    };
  }
}
