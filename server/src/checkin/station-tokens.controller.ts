import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { StationTokenBatch } from '@got/shared';
import { Public } from '../auth/decorators/public.decorator';
import { DomainException } from '../common/exceptions/domain.exception';
import { StationTokensService } from './station-tokens.service';
import { StationTokenAccessGuard, type RequestWithStationAccess } from './station.guard';

/**
 * `X-Station-Key` OR `checkin.station_token.issue` (§6.2.1). Neither is the
 * normal Bearer + `@RequirePermission()` shape, so this whole controller is
 * `@Public()` and `StationTokenAccessGuard` replaces the usual
 * `AuthGuard` → `PermissionsGuard` pipeline for these two routes only — see
 * that guard's doc comment for why `@RequirePermission()` cannot be used here.
 */
@Controller('checkin/station-tokens')
@Public()
@UseGuards(StationTokenAccessGuard)
export class StationTokensController {
  constructor(private readonly stationTokens: StationTokensService) {}

  /**
   * Route 42. A display polls this every ~2.5 minutes for a fresh batch; a
   * staff session with `checkin.station_token.issue` can call it to preview a
   * station. `2 / 60 s per credential` (§6.11.3) is enforced by
   * `UserThrottlerGuard`'s station-key-aware tracker, not by this decorator
   * alone — see that guard's doc comment.
   */
  @Get()
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  async issue(
    @Req() request: RequestWithStationAccess,
    @Query('station') stationCode?: string,
  ): Promise<StationTokenBatch> {
    return this.stationTokens.issueBatch({ preResolvedStation: request.station, stationCode });
  }

  /**
   * The epoch head check (§6.2.3). Polled once per slot boundary (~2/min).
   * `204` means the caller's cached batch is still good; `409
   * STATION_BATCH_STALE` means `tokenEpoch` (or the station itself) has moved
   * and the caller must discard its cache and refetch immediately — this is
   * what makes an epoch bump a ONE-SLOT panic button instead of a five-minute
   * one.
   */
  @Get('head')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async head(
    @Req() request: RequestWithStationAccess,
    @Query('station') stationCode: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
  ): Promise<void> {
    const { stale } = await this.stationTokens.checkHead(
      { preResolvedStation: request.station, stationCode },
      ifNoneMatch,
    );

    if (stale) {
      throw new DomainException(
        'STATION_BATCH_STALE',
        'The cached token batch is stale; discard and refetch.',
        HttpStatus.CONFLICT,
      );
    }
  }
}
