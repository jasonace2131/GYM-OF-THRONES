import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StationTokenBatch } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import { addDays, gymToday, zonedTimeToInstant } from '../common/time/gym-time';
import { GymConfigService } from '../config/gym.config';
import type { Env } from '../config/env.validation';
import { OpeningHoursService } from '../config/opening-hours.service';
import { PrismaService } from '../prisma/prisma.service';
import { StationTokenService } from './station-token.service';
import { gymHoursWindow, type GymHours, type GymHoursWindow } from './gym-hours';
import type { AuthenticatedStation } from './station.guard';

interface ResolveStationInput {
  /** Already resolved by `StationTokenAccessGuard` on the credential path — always this ONE station. */
  preResolvedStation?: AuthenticatedStation;
  /** `?station=<code>` — omitted iff exactly one active station exists (staff path only). */
  stationCode?: string;
}

interface MinimalStation {
  id: string;
  code: string;
  name: string;
  tokenEpoch: number;
  isActive: boolean;
}

/**
 * The I/O half of the station token: resolves a `Station` row, gates on gym
 * hours, and mints a batch by delegating the actual signing to the pure
 * `StationTokenService`. Everything here is a database read/write or a clock
 * read — nothing here is unit-tested in isolation from Postgres, which is
 * exactly why the crypto lives in the other file.
 */
@Injectable()
export class StationTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly gymConfig: GymConfigService,
    private readonly tokens: StationTokenService,
    private readonly openingHours: OpeningHoursService,
  ) {}

  async issueBatch(input: ResolveStationInput, now: Date = new Date()): Promise<StationTokenBatch> {
    const station = await this.resolveStation(input);
    const window = await this.assertMintWindow(now);

    const secret: string = this.config.get('STATION_TOKEN_SECRET');
    const slotSeconds = this.gymConfig.stationTokenSlotSeconds;
    const batchSize = this.gymConfig.stationTokenBatchSize;
    const currentSlot = this.tokens.computeSlot(now, slotSeconds);

    // Always the slots STARTING AT the current one — polling this endpoint
    // sixty times a minute must return the same window sixty times, never
    // mint an hour of future runway (§6.15's own regression note).
    const tokens = Array.from({ length: batchSize }, (_, offset) => {
      const slot = currentSlot + offset;
      const mac = this.tokens.sign(
        { stationId: station.id, tokenEpoch: station.tokenEpoch },
        slot,
        secret,
      );
      const bounds = this.tokens.slotBounds(slot, slotSeconds);
      return {
        slot,
        notBefore: bounds.notBefore.toISOString(),
        notAfter: bounds.notAfter.toISOString(),
        payload: this.tokens.buildPayload(station.code, slot, mac),
      };
    });

    // The heartbeat (§7.7 note 1): there is no separate POST .../heartbeat
    // because this column, written on every successful mint, already says the
    // same thing.
    await this.prisma.station.update({
      where: { id: station.id },
      data: { lastTokenIssuedAt: now },
    });

    return {
      station: { id: station.id, code: station.code, name: station.name },
      slotSeconds,
      serverTime: now.toISOString(),
      tokenEpoch: station.tokenEpoch,
      openUntil: window.closesAt.toISOString(),
      batchEtag: this.buildEtag(station, currentSlot),
      tokens,
    };
  }

  /**
   * The head check (§6.2.3). Returns `stale: true` the moment the caller's
   * cached `batchEtag` no longer agrees with the station's CURRENT
   * `tokenEpoch` — the per-station panic button's immediacy depends on this
   * running every slot boundary. The leading slot embedded in an `If-None-Match`
   * value is informational only; comparing it verbatim would report "stale"
   * on literally every poll, since 30 seconds always separates two polls.
   */
  async checkHead(
    input: ResolveStationInput,
    ifNoneMatch: string | undefined,
  ): Promise<{ stale: boolean }> {
    const station = await this.resolveStation(input);
    const etag = parseEtag(ifNoneMatch);

    const stale =
      etag === null || etag.code !== station.code || etag.tokenEpoch !== station.tokenEpoch;
    return { stale };
  }

  private async resolveStation(input: ResolveStationInput): Promise<MinimalStation> {
    if (input.preResolvedStation) {
      const station = input.preResolvedStation;
      if (!station.isActive) {
        throw new DomainException(
          'STATION_INACTIVE',
          'This station has been deactivated.',
          HttpStatus.CONFLICT,
        );
      }
      return station;
    }

    if (input.stationCode) {
      const station = await this.prisma.station.findUnique({ where: { code: input.stationCode } });
      if (!station) {
        throw new DomainException(
          'STATION_NOT_FOUND',
          'No station has that code.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (!station.isActive) {
        throw new DomainException(
          'STATION_INACTIVE',
          'This station has been deactivated.',
          HttpStatus.CONFLICT,
        );
      }
      return station;
    }

    const active = await this.prisma.station.findMany({ where: { isActive: true } });
    if (active.length === 0) {
      throw new DomainException(
        'STATION_NOT_FOUND',
        'No active station exists.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (active.length > 1) {
      throw new DomainException(
        'STATION_AMBIGUOUS',
        'More than one active station exists; pass ?station=<code>.',
        HttpStatus.CONFLICT,
      );
    }
    return active[0];
  }

  /**
   * The hours for the gym-local day containing `instant`, from Admin →
   * Settings with `GYM_OPEN_TIME` / `GYM_CLOSE_TIME` as the floor — the SAME
   * source `POST /checkin`'s gate reads (§6.2.4). This used to read the
   * environment directly, so after an owner edited the hours the lobby display
   * went dark at the old closing time while the door would still have
   * admitted the scan.
   */
  private async hoursOn(instant: Date): Promise<GymHours> {
    const day = await this.openingHours.forDate(instant);
    return {
      timeZone: this.gymConfig.timeZone,
      openTime: day.opensAt,
      closeTime: day.closesAt,
      isClosed: day.isClosed,
    };
  }

  /**
   * §6.2.4 rule 1: the token endpoint refuses to mint outside the window,
   * `410 GYM_CLOSED` with `nextOpensAt` — the display renders `CLOSED —
   * opens 5:00 AM` from it. A day marked closed refuses all day. This gate
   * applies HERE only; it never touches `POST /front-desk/check-ins` or
   * `MANUAL`, and it never lives inside `accessVerdict()`.
   */
  private async assertMintWindow(now: Date): Promise<GymHoursWindow> {
    const hours = await this.hoursOn(now);
    const window = gymHoursWindow(now, hours);
    if (hours.isClosed !== true && now >= window.opensAt && now <= window.closesAt) {
      return window;
    }

    const next = await this.nextOpening(now, hours, window);
    throw new DomainException(
      'GYM_CLOSED',
      'The gym is closed.',
      HttpStatus.GONE,
      next === null ? undefined : { nextOpensAt: next.toISOString() },
    );
  }

  /**
   * The next real opening — today's if the gym has not opened yet, otherwise
   * the first later day not marked closed, at THAT day's own opening time.
   * Unbuffered: the doors open at 05:00, not at the gate's 04:45. `null` only
   * when all seven days are marked closed; the display then shows no time.
   */
  private async nextOpening(
    now: Date,
    today: GymHours,
    window: GymHoursWindow,
  ): Promise<Date | null> {
    const timeZone = this.gymConfig.timeZone;
    const civilToday = gymToday(now, timeZone);
    if (today.isClosed !== true && now < window.opensAt) {
      return zonedTimeToInstant(civilToday, today.openTime, timeZone);
    }

    for (let ahead = 1; ahead <= 7; ahead += 1) {
      const day = addDays(civilToday, ahead);
      // Midday is safely inside that civil day whatever the offset.
      const hours = await this.hoursOn(zonedTimeToInstant(day, '12:00', timeZone));
      if (hours.isClosed !== true) return zonedTimeToInstant(day, hours.openTime, timeZone);
    }
    return null;
  }

  private buildEtag(station: MinimalStation, leadingSlot: number): string {
    return `${station.code}:${station.tokenEpoch}:${leadingSlot}`;
  }
}

function parseEtag(value: string | undefined): { code: string; tokenEpoch: number } | null {
  if (!value) return null;
  const [code, epochRaw] = value.split(':');
  const tokenEpoch = Number(epochRaw);
  if (!code || !Number.isInteger(tokenEpoch)) return null;
  return { code, tokenEpoch };
}
