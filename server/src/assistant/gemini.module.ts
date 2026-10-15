import { Module } from '@nestjs/common';
import { GeminiGateway } from './gemini-gateway.service';

/**
 * Provides the ONE `GeminiGateway` — client, model rotation and quota ledger —
 * to every module that calls Gemini. Nest modules are singletons, so the
 * assistant and the workout-plan suggester importing this share one ledger,
 * which is the point: they spend the same free quota.
 */
@Module({
  providers: [GeminiGateway],
  exports: [GeminiGateway],
})
export class GeminiModule {}
