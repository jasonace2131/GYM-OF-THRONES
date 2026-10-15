import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { PaginatedData } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ChatService, type ReviewThreadRow, type ThreadReview } from './chat.service';
import { ListReviewThreadsQueryDto, ReviewChatThreadDto } from './dto/chat.dto';

/**
 * Reading a coach-member conversation you are not part of — for a complaint,
 * never as routine monitoring.
 *
 * `chat.review`, ADMIN at ALL. Listing shows who talked to whom and when, and
 * no message text. Reading a conversation is a POST because it is an ACT: it
 * takes a reason, and every read is written to the audit log
 * (CHAT_THREAD_REVIEWED) with that reason.
 */
@Controller('admin/chat')
export class ChatReviewController {
  constructor(private readonly chat: ChatService) {}

  @Get('threads')
  @RequirePermission('chat.review')
  async threads(
    @Query() query: ListReviewThreadsQueryDto,
  ): Promise<PaginatedData<ReviewThreadRow>> {
    return this.chat.listForReview(query);
  }

  @Post('threads/:id/review')
  @RequirePermission('chat.review')
  async review(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewChatThreadDto,
  ): Promise<ThreadReview> {
    return this.chat.review(user, id, dto.reason);
  }
}
