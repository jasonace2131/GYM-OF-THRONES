import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { AuthUser } from '../../auth/auth.types';

/**
 * Rate-limits by authenticated user, falling back to IP for @Public() routes.
 *
 * The default IP tracker is actively wrong here: every member on the gym's
 * wi-fi shares one NAT address, and every member's phone is now a client of
 * this API, so one member retrying a check-in would throttle the entire
 * building out of the door at 06:00.
 *
 * Note this does NOT make IP tracking useless: §6.11.3 adds a SEPARATE
 * per-source-IP limit on POST /checkin that exempts GYM_EGRESS_CIDRS. That
 * one exists to bound a relay behind a consumer pool, it is deliberately not
 * this tracker, and the exemption is what keeps gym wi-fi out of its way.
 *
 * Stated honestly, because a comment claiming otherwise would be believed:
 * registering this guard AFTER AuthGuard does not keep a flood off the
 * database. AuthGuard resolves the local user before this guard runs, so an
 * authenticated flood costs one read per request regardless of the limit.
 * That is what the findUnique-first change in UserProvisioningService is for.
 * This guard's job is bounding abuse, not shielding Postgres.
 *
 * Storage is in-memory, so every limit is per instance.
 *
 * `GET /checkin/station-tokens[/head]` authenticates via `X-Station-Key`
 * rather than a Bearer token (§6.2.2), and that guard runs AFTER every global
 * guard — including this one — so `req.user`/`req.station` are never
 * populated yet when this tracker runs. Reading the raw header here, before
 * StationTokenAccessGuard resolves it against the database, is what makes
 * "2 / 60 s per credential" (§6.2.1) a real per-credential bucket instead of
 * degrading to per-IP for every station display. The header value is hashed
 * (never stored, never logged) so an in-memory throttler bucket key is never
 * a live secret.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Request & { user?: AuthUser }): Promise<string> {
    const stationKey = req.headers?.['x-station-key'];
    if (typeof stationKey === 'string' && stationKey.length > 0) {
      return Promise.resolve(
        `station-key:${createHash('sha256').update(stationKey).digest('hex')}`,
      );
    }
    return Promise.resolve(req.user ? `user:${req.user.id}` : `ip:${req.ip ?? 'unknown'}`);
  }
}
