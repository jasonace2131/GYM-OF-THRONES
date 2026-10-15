import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatReviewController } from './chat-review.controller';
import { ChatService } from './chat.service';
import { RealtimeBroadcastService } from './realtime-broadcast.service';

/**
 * Coach <-> member chat (feat/coach-tools).
 *
 * Postgres is the record and NestJS its only writer; Supabase Realtime
 * Broadcast is the doorbell. Why not a NestJS websocket: Vercel's rewrites do
 * not proxy a websocket upgrade, the direct Render host is blocked on 443 by
 * at least one Philippine ISP, and a free Render instance restarts and would
 * drop every socket. The browser holds one socket to Supabase instead.
 */
@Module({
  controllers: [ChatController, ChatReviewController],
  providers: [ChatService, RealtimeBroadcastService],
})
export class ChatModule {}
