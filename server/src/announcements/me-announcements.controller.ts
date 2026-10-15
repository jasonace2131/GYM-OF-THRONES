import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import type { AnnouncementsSeen, MemberAnnouncementFeed } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { MarkAnnouncementsSeenDto } from './dto/mark-announcements-seen.dto';
import { MemberAnnouncementsService } from './member-announcements.service';

/**
 * The member's noticeboard, with what is new to THEM — the dashboard's
 * Announcements section and the topbar bell both read this.
 *
 * Keyed on `announcement.read` like `GET /announcements`: every seeded role
 * holds it, so this is "signed in" in practice, and a role that loses the key
 * loses the bell (the portal hides it on 403) rather than seeing an error.
 *
 * The subject is always the token's user; nothing in a path, query or body can
 * name anybody else. `GET /announcements` and `GET /announcements/:id` stay
 * exactly as they were — the admin list reads the first, and the dashboard's
 * deep link falls back to the second for a notice beyond the loaded pages.
 */
@Controller('me/announcements')
export class MeAnnouncementsController {
  constructor(private readonly announcements: MemberAnnouncementsService) {}

  @Get()
  @RequirePermission('announcement.read')
  async feed(
    @CurrentUser() user: AuthUser,
    @Query() query: PaginationQueryDto,
  ): Promise<MemberAnnouncementFeed> {
    return this.announcements.feed(user.id, query, new Date());
  }

  /**
   * 200, not 201: nothing is created — a watermark moves (or, if a newer one
   * is already stored, does not).
   *
   * Deliberately NOT idempotency-keyed. The write is monotonic and clamped, so
   * a replay can only ever re-apply the same forward move; a replay table row
   * per bell-open would buy nothing and cost a write each time.
   */
  @Post('seen')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('announcement.read')
  async seen(
    @CurrentUser() user: AuthUser,
    @Body() dto: MarkAnnouncementsSeenDto,
  ): Promise<AnnouncementsSeen> {
    return this.announcements.markSeen(user.id, new Date(dto.upTo), new Date());
  }
}
