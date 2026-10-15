import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import type { MemberNoticeFeedWire, MemberNoticesSeenWire } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { MarkNoticesSeenDto } from './dto/mark-notices-seen.dto';
import { MemberNoticesService } from './member-notices.service';

/**
 * The member's own notices — the personal half of the portal bell, read beside
 * `GET /me/announcements`.
 *
 * KEYLESS, like the rest of `/me`: no @RequirePermission and no @Scope. Every
 * row here was written TO the caller, so a key could only ever mean "may read
 * your own notices", and a role that lost it would lose news about its own
 * bookings. AuthGuard is global, so both routes are still authenticated.
 *
 * The subject is the token's user and nothing else: no path, query or body
 * field can name another member, and the body DTO turns one that tries into a
 * 400. Staff are never sent notices, so their feed is simply empty.
 *
 * Nest resolves `me/notices` beside the `@Controller('me')` classes; each owns
 * its own sub-paths.
 */
@Controller('me/notices')
export class MeNoticesController {
  constructor(private readonly notices: MemberNoticesService) {}

  @Get()
  async feed(
    @CurrentUser() user: AuthUser,
    @Query() query: PaginationQueryDto,
  ): Promise<MemberNoticeFeedWire> {
    return this.notices.feed(user.id, query);
  }

  /**
   * 200, not 201: nothing is created — read stamps land on rows that exist.
   *
   * Deliberately NOT idempotency-keyed. The write only ever stamps rows that
   * are still unread, up to a mark the client already holds, so a replay finds
   * nothing left to stamp; a replay-table row per bell-open would buy nothing
   * and cost a write each time.
   */
  @Post('seen')
  @HttpCode(HttpStatus.OK)
  async seen(
    @CurrentUser() user: AuthUser,
    @Body() dto: MarkNoticesSeenDto,
  ): Promise<MemberNoticesSeenWire> {
    return this.notices.markSeen(user.id, new Date(dto.upTo), new Date());
  }
}
