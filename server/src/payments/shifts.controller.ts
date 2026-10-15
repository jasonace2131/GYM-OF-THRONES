import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ShiftsService } from './shifts.service';
import type { ShiftClosure, ShiftView } from './shift.presenter';
import { CloseShiftDto, OpenShiftDto } from './dto/shift.dto';

/**
 * Routes 38–40, all on `shift.manage` (FRONT_DESK + ADMIN).
 *
 * Nothing here is scoped: there is exactly one drawer, and a staffer who may
 * manage it may see all of it. That is why no handler takes `@Scope()` — Shift
 * has no `userId`, so `'ownedByUser'` would not even be the right subject.
 *
 * Declaration order matters only in that `@Get('current')` shares no shape
 * with any parameterised GET — there is deliberately no `GET /shifts/:id` in
 * this chunk, because the only reason to fetch a closed shift by id is to read
 * the expected figure, and that is disclosed once, in the close response.
 */
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Post('open')
  @RequirePermission('shift.manage')
  async open(@CurrentUser() user: AuthUser, @Body() dto: OpenShiftDto): Promise<ShiftView> {
    return this.shifts.open(user.id, dto);
  }

  /**
   * 200, not 201: the close mutates an existing drawer rather than creating a
   * resource. `@Idempotent()` because a double-tapped close on a flaky counter
   * connection must not turn into a 409 the staffer has to reason about — the
   * interceptor replays the stored closure, figures and all.
   */
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('shift.manage')
  @Idempotent()
  async close(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CloseShiftDto,
  ): Promise<ShiftClosure> {
    return this.shifts.close(user.id, id, dto);
  }

  /** Null is a valid, renderable answer: the drawer is simply shut. */
  @Get('current')
  @RequirePermission('shift.manage')
  async current(): Promise<ShiftView | null> {
    return this.shifts.current();
  }
}
