import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PaginatedData } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { Scope } from '../rbac/decorators/scope.decorator';
import { PermissionsService } from '../rbac/permissions.service';
import type { ScopedWhere } from '../rbac/scope.util';
import { Idempotent, IDEMPOTENCY_HEADER } from '../common/decorators/idempotent.decorator';
import { MembershipService } from './membership.service';
import { MembershipSalesService } from './membership-sales.service';
import { MembershipHoldsService } from './membership-holds.service';
import { MembershipLifecycleService } from './membership-lifecycle.service';
import { MembershipAlertsService, type MembershipAlertItem } from './membership-alerts.service';
import type { MembershipDetail, MembershipListItem } from './membership.presenter';
import { ListMembershipsQueryDto } from './dto/list-memberships-query.dto';
import { ListMembershipAlertsQueryDto } from './dto/list-membership-alerts-query.dto';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { RenewMembershipDto } from './dto/renew-membership.dto';
import { FreezeMembershipDto, UnfreezeMembershipDto } from './dto/freeze-membership.dto';
import { CancelMembershipDto, RequestCancellationDto } from './dto/cancellation.dto';
import { AdjustTermDto, CorrectMembershipDto } from './dto/adjust-term.dto';

type MembershipScope = ScopedWhere<Prisma.MembershipWhereInput>;

/**
 * Routes 20 and 21. Tasks 12–15 append their writes to this controller.
 *
 * Subject 'ownedByUser' is right for Membership: it hangs off User via userId,
 * and notDeletedUserWhere is deliberately NOT applied — Membership has no
 * deletedAt column, and buildScopeWhere folds that filter in for subject 'user'
 * only. A member is soft-deleted on User, and their membership follows because
 * the scope reaches it through that relation.
 */
@Controller('memberships')
export class MembershipsController {
  constructor(
    private readonly memberships: MembershipService,
    private readonly sales: MembershipSalesService,
    private readonly permissions: PermissionsService,
    private readonly holds: MembershipHoldsService,
    private readonly lifecycle: MembershipLifecycleService,
    private readonly alerts: MembershipAlertsService,
  ) {}

  @Get()
  @RequirePermission('membership.read')
  async list(
    @Query() query: ListMembershipsQueryDto,
    @Scope('ownedByUser') scope: MembershipScope,
  ): Promise<PaginatedData<MembershipListItem>> {
    return this.memberships.list(query, scope, new Date());
  }

  /**
   * The Notifications panel's expiry alerts, one page at a time: ending soon,
   * then lapsed, with search and an archived view. Declared before `:id`, which
   * would otherwise take "alerts" as an id and 400 it.
   */
  @Get('alerts')
  @RequirePermission('membership.read')
  async listAlerts(
    @Query() query: ListMembershipAlertsQueryDto,
    @Scope('ownedByUser') scope: MembershipScope,
  ): Promise<PaginatedData<MembershipAlertItem>> {
    return this.alerts.list(query, scope, new Date());
  }

  /**
   * Archive this term's expiry alert. `notification.resolve`, like archiving a
   * system notice: it clears a reminder and changes no membership.
   */
  @Post(':id/expiry-alert/archive')
  @HttpCode(200)
  @RequirePermission('notification.resolve')
  async archiveAlert(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ archivedFor: string }> {
    return this.alerts.archive(id);
  }

  @Post(':id/expiry-alert/restore')
  @HttpCode(200)
  @RequirePermission('notification.resolve')
  async restoreAlert(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ restored: true }> {
    return this.alerts.restore(id);
  }

  /**
   * `payments` is gated on the caller's RESOLVED payment.read, not on
   * user.role: a role test would hard-code today's grant table into a handler
   * and silently stop agreeing with it the first time a grant is edited. A
   * COACH holds membership.read at OWN and no payment.read at all, so they see
   * the member they coach without their billing history.
   */
  @Get(':id')
  @RequirePermission('membership.read')
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Scope('ownedByUser') scope: MembershipScope,
  ): Promise<MembershipDetail> {
    const held = await this.permissions.getEffectivePermissions(user);
    const includePayments = held.some((permission) => permission.key === 'payment.read');
    return this.memberships.findOne(id, scope, new Date(), { includePayments });
  }

  /**
   * Route 22. `@Idempotent()` is not optional on a money write: the interceptor
   * claims the key BEFORE the handler runs, so a desk staffer double-tapping
   * SELL gets one membership, one Payment and a 200 replay of the first receipt.
   */
  @Post()
  @RequirePermission('membership.sell')
  @Idempotent()
  async sell(
    @CurrentUser() user: AuthUser,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string,
    @Body() dto: CreateMembershipDto,
  ): Promise<MembershipDetail> {
    return this.sales.sell(user, dto, idempotencyKey, new Date());
  }

  /** Route 23. The server decides which of §5.7.3's four cases this is. */
  @Post(':id/renew')
  @RequirePermission('membership.sell')
  @Idempotent()
  async renew(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string,
    @Body() dto: RenewMembershipDto,
  ): Promise<MembershipDetail> {
    return this.sales.renew(user, id, dto, idempotencyKey, new Date());
  }

  /**
   * Route 26. ADMIN only — the "no" belongs to the owner, not the desk.
   * @HttpCode(200): this mutates an existing row, it does not create one.
   */
  @Post(':id/freeze')
  @HttpCode(200)
  @RequirePermission('membership.freeze')
  async freeze(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: FreezeMembershipDto,
  ): Promise<MembershipDetail> {
    return this.holds.freeze(user, id, dto, new Date());
  }

  /** Route 27. */
  @Post(':id/unfreeze')
  @HttpCode(200)
  @RequirePermission('membership.freeze')
  async unfreeze(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UnfreezeMembershipDto,
  ): Promise<MembershipDetail> {
    return this.holds.unfreeze(user, id, dto, new Date());
  }

  /** Route 24. FRONT_DESK holds this key: taking notice is counter work. */
  @Post(':id/cancel-request')
  @RequirePermission('membership.cancel.request')
  async requestCancellation(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RequestCancellationDto,
  ): Promise<MembershipDetail> {
    return this.lifecycle.requestCancellation(user, id, dto, new Date());
  }

  /** Route 25. No body: `forbidNonWhitelisted` would 400 one anyway. */
  @Delete(':id/cancel-request')
  @RequirePermission('membership.cancel.request')
  async withdrawCancellation(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<MembershipDetail> {
    return this.lifecycle.withdrawCancellation(user, id, new Date());
  }

  /** Route 28. Dangerous, ADMIN only — this forfeits the rest of a paid term. */
  @Post(':id/cancel')
  @RequirePermission('membership.cancel')
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CancelMembershipDto,
  ): Promise<MembershipDetail> {
    return this.lifecycle.cancel(user, id, dto, new Date());
  }

  /** Route 29. Comp days, 1..60, positive only. */
  @Post(':id/adjust-term')
  @RequirePermission('membership.term.adjust')
  async adjustTerm(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AdjustTermDto,
  ): Promise<MembershipDetail> {
    return this.lifecycle.adjustTerm(user, id, dto, new Date());
  }

  /** Route 30. The documented bypass of the transition table. */
  @Post(':id/correct')
  @RequirePermission('membership.status.correct')
  async correct(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CorrectMembershipDto,
  ): Promise<MembershipDetail> {
    return this.lifecycle.correct(user, id, dto, new Date());
  }
}
