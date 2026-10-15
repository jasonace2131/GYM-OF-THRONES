import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { CheckInResult, CheckInStatus } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CheckInDto } from './dto/check-in.dto';
import { CheckInService } from './check-in.service';

/**
 * `POST /api/v1/checkin` — the member's own scan.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 200 IN EVERY BUSINESS OUTCOME, INCLUDING EVERY DENIAL.
 *
 * `client/src/lib/api.ts` throws on `!body.success`, so a denial thrown as a
 * 4xx reaches a member's phone as a bare `Error` with no reason and no next
 * step. The line is drawn on "was this a check-in attempt I can reason
 * about?":
 *
 *   400 STATION_TOKEN_MALFORMED   the client's own regex should have caught it
 *   400 STATION_TOKEN_INVALID     unknown / inactive / forged / wrong epoch —
 *                                 ONE code, deliberately indistinguishable
 *   422 STATION_TOKEN_NOT_YET_VALID   a station-CLOCK alarm, not a member action
 *   200 STATION_TOKEN_EXPIRED     a denial row — they were a few seconds late
 *   200 GYM_CLOSED, CHECKIN_DAILY_LIMIT, every membership reason
 *
 * The portal renders ONE catch-all for any non-2xx here — "Check-in is
 * unavailable, please see the front desk" — rather than five screens for five
 * things that mean the same thing to a member standing at a counter.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * NO `@Idempotent()`, DELIBERATELY. `StationScan @@unique([userId, stationId,
 * slot])` IS this route's idempotency key and is strictly stronger — it also
 * catches two devices signed into one account presenting the same code.
 * `api.ts` injects `Idempotency-Key` on every POST; it is ignored here.
 * Honouring both would give two idempotency mechanisms that can disagree,
 * which is worse than either alone.
 *
 * NO `@Scope()`, DELIBERATELY. There is no id in the body and none in the
 * path: identity comes from the JWT, and a body that could name a member would
 * let any authenticated account check in anyone else. `checkin.self` is held
 * at `OWN` by CLIENT, COACH, FRONT_DESK and ADMIN — staff who train check
 * themselves in through this same route.
 */
@Controller('checkin')
export class CheckInController {
  constructor(private readonly checkIns: CheckInService) {}

  /**
   * Two limits, both real (§6.11.3).
   *
   * `default` is keyed on the authenticated user by `UserThrottlerGuard` and
   * bounds ONE account's retries — a relay is N accounts submitting once each,
   * which never trips it. `origin` is keyed on the source IP and exempts
   * `GYM_EGRESS_CIDRS`, which is what bounds a consumer pool behind one
   * address while leaving the 06:00 peak on gym wifi untouched.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('checkin.self')
  @Throttle({
    default: { limit: 10, ttl: 60_000 },
    origin: { limit: 60, ttl: 60_000 },
  })
  async check(
    @CurrentUser() user: AuthUser,
    @Body() dto: CheckInDto,
    @Req() request: Request,
  ): Promise<CheckInResult> {
    return this.checkIns.recordStationScan(user, dto.stationToken, request.ip);
  }
}

/**
 * `GET /api/v1/me/check-in-status`.
 *
 * Keyless and hard-coded to the caller's own id, exactly like the rest of
 * `/me` — CLIENT holds none of the `checkin.*` read keys, so `OWN` never has
 * to mean two different things depending on who is asking.
 *
 * Nest resolves this alongside `MeController` and `UsersController`, which
 * both also carry `@Controller('me')`: each owns its own sub-paths, so there
 * is no collision.
 */
@Controller('me')
export class CheckInStatusController {
  constructor(private readonly checkIns: CheckInService) {}

  @Get('check-in-status')
  async status(@CurrentUser() user: AuthUser): Promise<CheckInStatus> {
    return this.checkIns.statusFor(user);
  }
}
