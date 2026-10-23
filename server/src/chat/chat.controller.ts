import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Prisma } from '@prisma/client';
import type { ChatMessagePage, ChatMessageView, ChatThreadList, ChatThreadView } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RequireActiveMembership } from '../membership/require-active-membership.decorator';
import { Scope } from '../rbac/decorators/scope.decorator';
import type { ScopedWhere } from '../rbac/scope.util';
import { ChatService } from './chat.service';
import { ListChatMessagesQueryDto, SendChatMessageDto } from './dto/chat.dto';

/**
 * Coach <-> member chat, for its two participants.
 *
 * `chat.use` on every route (CLIENT and COACH, both at OWN). Its scope is not
 * what limits a caller — the SUBJECT is always the caller, and `ChatService`
 * asks `threadAccess` whether they are this thread's coach or member. The one
 * route that names somebody else, `threads/with/:memberId`, carries
 * `@Scope('coachedMember')` as well.
 *
 * Unscoped misses are 404s. `chat.review` (ADMIN) reads through
 * `ChatReviewController`, audited, never through here.
 */
@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('threads')
  @RequirePermission('chat.use')
  async threads(@CurrentUser() user: AuthUser): Promise<ChatThreadList> {
    return this.chat.listThreads(user);
  }

  /** `before`/`after` take a message id; neither is the newest page. */
  @Get('threads/:id/messages')
  @RequirePermission('chat.use')
  async messages(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListChatMessagesQueryDto,
  ): Promise<ChatMessagePage> {
    return this.chat.listMessages(user, id, query);
  }

  /**
   * Save, then broadcast. 20 a minute per user: a person typing never gets
   * near it, and a stuck key or a script does.
   *
   * Not `@Idempotent()`: the same words twice is a legitimate thing to send,
   * and `apiFetch` mints a fresh key per call anyway, so a double-tap would
   * never share one.
   */
  @Post('threads/:id/messages')
  @RequirePermission('chat.use')
  @RequireActiveMembership()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async send(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendChatMessageDto,
  ): Promise<ChatMessageView> {
    return this.chat.send(user, id, dto);
  }

  @Post('threads/:id/read')
  @RequirePermission('chat.use')
  async read(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ threadId: string; lastReadAt: string }> {
    return this.chat.markRead(user, id);
  }

  /** The sender withdraws their own message within ten minutes. 200 with the tombstone. */
  @Delete('messages/:id')
  @RequirePermission('chat.use')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChatMessageView> {
    return this.chat.deleteMessage(user, id);
  }

  /** A coach opens, or gets, the thread with a member they actively coach. */
  @Post('threads/with/:memberId')
  @RequirePermission('chat.use')
  async openWith(
    @CurrentUser() user: AuthUser,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Scope('coachedMember') scope: ScopedWhere<Prisma.UserWhereInput>,
  ): Promise<ChatThreadView> {
    return this.chat.openWithMember(user, memberId, scope);
  }
}
