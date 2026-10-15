import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ConsentService, type ConsentStanding } from './consent.service';
import { AcceptConsentDto } from './dto/accept-consent.dto';

/**
 * The caller's own consent standing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO `@RequirePermission`, AND NO `@Scope`. Deliberate, and it matches the
 * rest of `/me`: the subject is `request.user` and there is no path or body
 * parameter that could name somebody else, so there is nothing to scope. A
 * permission key would also be wrong in kind — every signed-in account must
 * be able to accept the documents, including one that has just been created
 * and holds almost nothing.
 *
 * WHY A SEPARATE CALL RATHER THAN PART OF REGISTRATION: sign-up goes straight
 * from the browser to Supabase and never touches this API, so there is no
 * server-side moment during registration to write anything. The client calls
 * this immediately after `signUp` succeeds, and the portal gate is what makes
 * skipping it useless rather than merely discouraged.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Controller('me/consent')
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  /** What this member still owes. Cheap, and the portal calls it on load. */
  @Get()
  async standing(@CurrentUser() user: AuthUser): Promise<ConsentStanding> {
    return this.consent.standing(user.id);
  }

  /**
   * 200, not 201: the response is the caller's resulting STANDING, not a
   * pointer to a created row. A client cannot address a ConsentRecord and has
   * no reason to — the only question it ever asks is "am I up to date".
   *
   * Tightened below the default bucket. A member accepts three documents once
   * and then again only when a version changes; anything past a handful a
   * minute is a stuck retry loop or a script, and each attempt is a write.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async accept(
    @CurrentUser() user: AuthUser,
    @Body() dto: AcceptConsentDto,
    @Req() request: Request,
  ): Promise<ConsentStanding> {
    return this.consent.accept(user.id, dto.kinds, {
      // `app.set('trust proxy', 1)` in main.ts is what makes this the client
      // rather than the load balancer. Hashed before storage, never kept raw.
      ip: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
    });
  }
}
