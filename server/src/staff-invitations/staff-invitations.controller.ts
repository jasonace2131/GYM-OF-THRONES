import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type {
  IssuedStaffInvitation,
  StaffInviteAccepted,
  StaffInviteClaim,
  StaffInvitationLookup,
  StaffInvitationView,
} from '@got/shared';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  CreateStaffInvitationDto,
  StaffInvitationLookupQueryDto,
  StaffInvitationTokenDto,
} from './dto/staff-invitation.dto';
import { StaffInvitationsService } from './staff-invitations.service';

/**
 * Staff & Access: inviting people to join as front desk, coach or admin.
 *
 * Three audiences, and the decorators say which is which:
 *
 *   - `staff.invite` (ADMIN, and DEV through its bypass): list, issue,
 *     re-send and withdraw. Which ROLES a caller may invite is the role
 *     hierarchy's call, in the service.
 *   - `@Public()` and throttled: `lookup` and `claim-link`, which the invite
 *     page calls before anybody is signed in. The token is the only
 *     credential, so both answer as little as they can.
 *   - Any signed-in account: `accept`. The service checks the caller's
 *     address against the invitation's.
 *
 * `Origin` is read so the links point back at the site that asked — but only
 * when CORS_ORIGIN already trusts it (`resolveAppOrigin`).
 */
@Controller('staff-invitations')
export class StaffInvitationsController {
  constructor(private readonly invitations: StaffInvitationsService) {}

  /**
   * Public. 10 a minute per caller, 30 per source address: a person opens
   * their invitation a handful of times; anything more is guessing tokens —
   * which, at 256 bits, is hopeless anyway, and this keeps it quiet.
   */
  @Get('lookup')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 }, origin: { limit: 30, ttl: 60_000 } })
  async lookup(@Query() query: StaffInvitationLookupQueryDto): Promise<StaffInvitationLookup> {
    return this.invitations.lookup(query.token);
  }

  @Get()
  @RequirePermission('staff.invite')
  async list(): Promise<StaffInvitationView[]> {
    return this.invitations.list();
  }

  @Post()
  @RequirePermission('staff.invite')
  async create(
    @Body() dto: CreateStaffInvitationDto,
    @CurrentUser() user: AuthUser,
    @Headers('origin') origin: string | undefined,
  ): Promise<IssuedStaffInvitation> {
    return this.invitations.create(user, dto, origin);
  }

  /**
   * Public. Tighter than lookup — 5 a minute — because each call can create a
   * Supabase account. 200, not 201: the resource here is a link, not a row.
   */
  @Post('claim-link')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 }, origin: { limit: 20, ttl: 60_000 } })
  async claimLink(
    @Body() dto: StaffInvitationTokenDto,
    @Headers('origin') origin: string | undefined,
  ): Promise<StaffInviteClaim> {
    return this.invitations.claimLink(dto.token, origin);
  }

  /** Signed in, no permission key: the invitation itself is the authority. */
  @Post('accept')
  @HttpCode(200)
  async accept(
    @Body() dto: StaffInvitationTokenDto,
    @CurrentUser() user: AuthUser,
  ): Promise<StaffInviteAccepted> {
    return this.invitations.accept(user, dto.token);
  }

  @Post(':id/resend')
  @HttpCode(200)
  @RequirePermission('staff.invite')
  async resend(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthUser,
    @Headers('origin') origin: string | undefined,
  ): Promise<IssuedStaffInvitation> {
    return this.invitations.resend(user, id, origin);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePermission('staff.invite')
  async revoke(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<StaffInvitationView> {
    return this.invitations.revoke(user, id);
  }
}
