import { Body, Controller, Get, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { MemberJoinAccepted, MemberJoinClaim, MemberJoinLookup } from '@got/shared';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { AcceptMemberJoinDto, MemberJoinTokenDto } from './dto/member-join.dto';
import { MemberJoinService } from './member-join.service';

/**
 * The member setup page's three calls (`/join/<token>`), the counterpart of
 * `StaffInvitationsController`'s public half — same throttles, same reasons:
 * a person opens their link a handful of times, and each claim can mint a
 * Supabase sign-in link.
 */
@Controller('member-join')
export class MemberJoinController {
  constructor(private readonly memberJoin: MemberJoinService) {}

  @Get('lookup')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 }, origin: { limit: 30, ttl: 60_000 } })
  async lookup(@Query() query: MemberJoinTokenDto): Promise<MemberJoinLookup> {
    return this.memberJoin.lookup(query.token);
  }

  @Post('claim-link')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 }, origin: { limit: 20, ttl: 60_000 } })
  async claimLink(
    @Body() dto: MemberJoinTokenDto,
    @Headers('origin') origin: string | undefined,
  ): Promise<MemberJoinClaim> {
    return this.memberJoin.claimLink(dto.token, origin);
  }

  /** Signed in, no permission key: the link itself is the authority, checked against the caller. */
  @Post('accept')
  @HttpCode(200)
  async accept(
    @Body() dto: AcceptMemberJoinDto,
    @CurrentUser() user: AuthUser,
  ): Promise<MemberJoinAccepted> {
    return this.memberJoin.accept(user.id, dto.token, dto.dateOfBirth);
  }
}
