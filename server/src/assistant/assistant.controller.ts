import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RequireActiveMembership } from '../membership/require-active-membership.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { AssistantService } from './assistant.service';
import { AskAssistantDto } from './dto/ask-assistant.dto';

/**
 * The member assistant.
 *
 * Keyless in the sense that matters: like every `/me` route, the subject is
 * `request.user` and there is no path or body parameter that could name
 * somebody else. `ai.chat.use` and `ai.chat.history.read` are still required —
 * they were reserved for this in the RBAC spec §9 and are seeded to CLIENT at
 * scope OWN — so an account can be cut off from the assistant without touching
 * anything else.
 */
@Controller('me/assistant')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Tightened well below the default bucket.
   *
   * Every call to this route spends real money on an upstream API, which no
   * other endpoint in this system does. The per-user default of 100/minute
   * would let one member run up a bill on a held-down key; ten a minute is
   * more than a person types and bounds the damage.
   */
  @Post('messages')
  @RequirePermission('ai.chat.use')
  @RequireActiveMembership()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async ask(
    @CurrentUser() user: AuthUser,
    @Body() dto: AskAssistantDto,
  ): Promise<{ conversationId: string; answer: string; toolCallCount: number; model: string }> {
    return this.assistant.ask(user.id, dto.conversationId ?? null, dto.message);
  }

  /** Whether the feature is configured at all, so the portal can hide it. */
  @Get('status')
  @RequirePermission('ai.chat.use')
  status(): { enabled: boolean } {
    return { enabled: this.assistant.enabled };
  }

  @Get('conversations')
  @RequirePermission('ai.chat.history.read')
  async conversations(
    @CurrentUser() user: AuthUser,
  ): Promise<{ id: string; title: string; updatedAt: string }[]> {
    const rows = await this.prisma.aiConversation.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      take: 30,
      select: { id: true, title: true, updatedAt: true },
    });

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /**
   * 404 rather than 403 for a conversation belonging to somebody else.
   *
   * The `userId` in the where clause makes another member's conversation
   * indistinguishable from one that does not exist — a 403 would confirm the
   * id is real, which is an enumeration oracle.
   */
  @Get('conversations/:id')
  @RequirePermission('ai.chat.history.read')
  async conversation(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ role: string; content: string; createdAt: string }[]> {
    const rows = await this.prisma.aiMessage.findMany({
      where: { conversationId: id, conversation: { userId: user.id } },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true, createdAt: true },
    });

    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
