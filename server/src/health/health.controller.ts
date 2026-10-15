import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';

/**
 * Health check endpoint.
 * Used by Railway deployment health checks and monitoring tools.
 * Must be version-neutral so it works at /api/health regardless of API version.
 *
 * @Public() because AuthGuard runs on every route by default — Railway's
 * health probe has no token, and an unauthenticated 401 would make the
 * deployment look permanently unhealthy.
 *
 * @SkipThrottle() because the probe has no user and therefore tracks by the
 * platform's egress IP. At one probe every 10 seconds it would spend 6 of the
 * 100-request minute budget shared with every other anonymous caller on that
 * address, and a throttled 429 reads as an unhealthy deployment.
 */
@Public()
@SkipThrottle()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  @Get()
  check(): { status: string; timestamp: string; uptime: number } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    };
  }
}
