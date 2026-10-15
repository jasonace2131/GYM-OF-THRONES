import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { Scope } from '../rbac/decorators/scope.decorator';
import type { ScopedWhere } from '../rbac/scope.util';
import { Idempotent, IDEMPOTENCY_HEADER } from '../common/decorators/idempotent.decorator';
import { PaymentsService, type PaymentListResult } from './payments.service';
import type { PaymentSummary } from './payment.presenter';
import type { PaymentDetail } from './payment-detail.presenter';
import type { ReceiptDoc } from './receipt.presenter';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { VoidPaymentDto } from './dto/void-payment.dto';
import { AmendPaymentDto } from './dto/amend-payment.dto';
import { ListPaymentsQueryDto } from './dto/list-payments-query.dto';

type PaymentScope = ScopedWhere<Prisma.PaymentWhereInput>;

/**
 * Routes 33–35.
 *
 * One @RequirePermission key per route. POST /payments carries payment.record
 * only — the discount check is an in-service call against
 * PermissionsService.getEffectivePermissions, because a method-level decorator
 * REPLACES a class-level one and a second key on one route is unrepresentable.
 *
 * Subject 'ownedByUser' is right for Payment: it hangs off User via userId, and
 * notDeletedUserWhere is deliberately NOT applied — Payment has no deletedAt
 * column and buildScopeWhere folds that filter in for subject 'user' only.
 */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @RequirePermission('payment.read')
  async list(
    @Query() query: ListPaymentsQueryDto,
    @Scope('ownedByUser') scope: PaymentScope,
  ): Promise<PaymentListResult> {
    return this.payments.list(query, scope);
  }

  /**
   * The printable TRANSACTION SLIP's data. Printing is reading, so this rides
   * payment.read — a `payment.invoice.print` key would be a catalogue entry
   * and two role grants for no separation of duty. Plain JSON through
   * TransformInterceptor; the CLIENT renders the HTML, which is what spares
   * this route the @Header override dance the CSV reports need.
   */
  @Get(':id/receipt')
  @RequirePermission('payment.read')
  async receipt(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ReceiptDoc> {
    return this.payments.receipt(id, new Date());
  }

  /**
   * ONE payment, for the register's detail drawer.
   *
   * DECLARED AFTER `:id/receipt` ON PURPOSE. Nest matches routes in
   * declaration order, so a bare `:id` above it would swallow
   * `/payments/<uuid>/receipt` and hand the slip printer a payment detail
   * body it cannot render.
   *
   * Scoped like the list, through the same `ownedByUser` subject: a caller at
   * OWN must not be able to read a payment by guessing its id.
   */
  @Get(':id')
  @RequirePermission('payment.read')
  async detail(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Scope('ownedByUser') scope: PaymentScope,
  ): Promise<PaymentDetail> {
    return this.payments.detail(id, scope);
  }

  /**
   * 201 on the first call, 200 on a replay — IdempotencyInterceptor observes the
   * finished body and emits it verbatim, so a replay carries exactly one
   * envelope. The header value is also stored on the Payment as
   * idempotencyKey @unique, which is what protects the INTERNAL callers whose
   * keys never come from a header at all.
   */
  @Post()
  @RequirePermission('payment.record')
  @Idempotent()
  async record(
    @CurrentUser() user: AuthUser,
    @Body() dto: RecordPaymentDto,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string,
  ): Promise<PaymentSummary> {
    return this.payments.record(user, dto, idempotencyKey, new Date());
  }

  /**
   * Deliberately NOT @Idempotent(): the RECORDED → VOIDED guarded update is
   * already idempotent in the only way that matters, and a second void is a
   * 422 the console must see rather than a replayed 200 that pretends it worked.
   */
  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payment.void')
  async voidPayment(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: VoidPaymentDto,
  ): Promise<PaymentSummary> {
    return this.payments.void(user, id, dto, new Date());
  }

  /**
   * "Edit payment" — void the original and write a corrected replacement.
   *
   * POST `:id/amend`, not `PATCH :id`, because the route does not partially
   * update that row: it creates a DIFFERENT one and links it. `POST :id/void`
   * is the precedent.
   *
   * Deliberately NOT @Idempotent(), same reasoning as void: a second amend is
   * a 422 the console must see rather than a replayed 200 that pretends it
   * worked. The row-level `idempotencyKey: amend:<id>` still makes a
   * double-submit of the same body a true replay.
   */
  @Post(':id/amend')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payment.amend')
  async amend(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AmendPaymentDto,
  ): Promise<PaymentSummary> {
    return this.payments.amend(user, id, dto, new Date());
  }

  /**
   * Hide a payment from the register, and put it back.
   *
   * A SOFT DELETE, mirroring `User.deletedAt`: no report, shift closure or
   * BIR register reads `archivedAt`, so neither route moves a single figure.
   * Not @Idempotent() — a second archive is a 422 the console must see.
   */
  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payment.archive')
  async archive(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<PaymentSummary> {
    return this.payments.archive(user, id, new Date());
  }

  @Post(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payment.archive')
  async unarchive(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<PaymentSummary> {
    return this.payments.unarchive(user, id, new Date());
  }
}
