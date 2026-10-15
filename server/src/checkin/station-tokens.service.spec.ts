import type { ConfigService } from '@nestjs/config';
import { GymConfigService } from '../config/gym.config';
import type { Env } from '../config/env.validation';
import { OpeningHoursService } from '../config/opening-hours.service';
import { StationTokenService } from './station-token.service';
import { StationTokensService } from './station-tokens.service';

const ENV_DEFAULTS: Partial<Env> = {
  GYM_TIMEZONE: 'Asia/Manila',
  GYM_OPEN_TIME: '05:00',
  GYM_CLOSE_TIME: '22:00',
  MEMBERSHIP_GRACE_DAYS: 3,
  MEMBERSHIP_EXPIRING_SOON_DAYS: 7,
  MEMBERSHIP_FREEZE_MIN_DAYS: 7,
  MEMBERSHIP_FREEZE_MAX_DAYS: 90,
  MEMBERSHIP_FREEZE_ANNUAL_CAP_DAYS: 90,
  MEMBERSHIP_GRACE_ADMISSIONS_MAX: 3,
  MEMBERSHIP_FREEZE_FEE_CENTAVOS: 10000,
  SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS: 20000,
  GYM_VAT_REGISTERED: false,
  STATION_TOKEN_SLOT_SECONDS: 30,
  STATION_TOKEN_BATCH_SIZE: 10,
  CHECKIN_MIN_SESSION_MINUTES: 20,
  IDEMPOTENCY_RETENTION_HOURS: 24,
  SCHEDULER_ENABLED: false,
};

function fakeConfigService(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const values = { ...ENV_DEFAULTS, ...overrides } as Env;
  return {
    get: (key: keyof Env) => values[key],
  } as unknown as ConfigService<Env, true>;
}

function stationRow(
  overrides: Partial<{
    id: string;
    code: string;
    name: string;
    tokenEpoch: number;
    isActive: boolean;
  }> = {},
) {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    code: '9F2K',
    name: 'Front desk',
    gymCode: 'GOT',
    tokenEpoch: 1,
    isActive: true,
    lastTokenIssuedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('StationTokensService', () => {
  const NOON_MANILA = new Date('2026-08-18T04:00:00.000Z'); // 12:00 PM Manila

  /**
   * `hours` are Admin → Settings rows (`OpeningHours`). None by default, so
   * every day falls back to GYM_OPEN_TIME / GYM_CLOSE_TIME.
   */
  function build(
    configOverrides: Partial<Env> = {},
    hours: { dayOfWeek: number; opensAt: string; closesAt: string; isClosed: boolean }[] = [],
  ) {
    const config = fakeConfigService({ STATION_TOKEN_SECRET: 's'.repeat(32), ...configOverrides });
    const gymConfig = new GymConfigService(config);
    const prisma = {
      station: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
      openingHours: { findMany: jest.fn().mockResolvedValue(hours) },
    };
    const openingHours = new OpeningHoursService(prisma as never, gymConfig, {} as never);
    const service = new StationTokensService(
      prisma as never,
      config,
      gymConfig,
      new StationTokenService(),
      openingHours,
    );
    return { service, prisma, gymConfig };
  }

  describe('gym-hours gate (§6.2.4)', () => {
    it('mints inside the window', async () => {
      const { service, prisma } = build();
      const station = stationRow();
      prisma.station.findMany.mockResolvedValue([station]);

      const batch = await service.issueBatch({}, NOON_MANILA);
      expect(batch.tokens).toHaveLength(10);
    });

    it('refuses to mint before GYM_OPEN_TIME − 15m, with 410 GYM_CLOSED and nextOpensAt', async () => {
      const { service, prisma } = build();
      prisma.station.findMany.mockResolvedValue([stationRow()]);

      // 04:30 Manila — 30 minutes before the 05:00 open time, outside the 15m buffer.
      const beforeOpen = new Date('2026-08-17T20:30:00.000Z');

      await expect(service.issueBatch({}, beforeOpen)).rejects.toMatchObject({
        response: {
          code: 'GYM_CLOSED',
          details: { nextOpensAt: '2026-08-17T21:00:00.000Z' }, // 05:00 Manila = 21:00 UTC prior day
        },
      });
    });

    it('mints inside the 15-minute pre-open buffer', async () => {
      const { service, prisma } = build();
      prisma.station.findMany.mockResolvedValue([stationRow()]);

      // 04:50 Manila — 10 minutes before open, inside the buffer.
      const withinBuffer = new Date('2026-08-17T20:50:00.000Z');
      const batch = await service.issueBatch({}, withinBuffer);
      expect(batch.tokens).toHaveLength(10);
    });

    it('refuses to mint after GYM_CLOSE_TIME + 15m, with nextOpensAt pointing at TOMORROW', async () => {
      const { service, prisma } = build();
      prisma.station.findMany.mockResolvedValue([stationRow()]);

      // 22:30 Manila — 30 minutes after the 22:00 close time.
      const afterClose = new Date('2026-08-18T14:30:00.000Z');

      await expect(service.issueBatch({}, afterClose)).rejects.toMatchObject({
        response: {
          code: 'GYM_CLOSED',
          details: { nextOpensAt: '2026-08-18T21:00:00.000Z' }, // next day 05:00 Manila
        },
      });
    });
  });

  // 2026-08-18 is a TUESDAY in Manila (dayOfWeek 2).
  describe('hours edited in Admin → Settings win over the environment', () => {
    const day = (dayOfWeek: number, opensAt: string, closesAt: string, isClosed = false) => ({
      dayOfWeek,
      opensAt,
      closesAt,
      isClosed,
    });
    const everyDay = (opensAt: string, closesAt: string) =>
      Array.from({ length: 7 }, (_, d) => day(d, opensAt, closesAt));

    it('keeps minting past the env close when Settings closes later', async () => {
      const { service, prisma } = build({}, everyDay('05:00', '23:00'));
      prisma.station.findMany.mockResolvedValue([stationRow()]);

      // 22:30 Manila: past GYM_CLOSE_TIME 22:00 + 15m, inside Settings' 23:00.
      const batch = await service.issueBatch({}, new Date('2026-08-18T14:30:00.000Z'));
      expect(batch.tokens).toHaveLength(10);
      expect(batch.openUntil).toBe('2026-08-18T15:15:00.000Z'); // 23:15 Manila
    });

    it('refuses before a later Settings opening, and names that opening', async () => {
      const { service, prisma } = build({}, everyDay('07:00', '22:00'));
      prisma.station.findMany.mockResolvedValue([stationRow()]);

      // 06:00 Manila: inside the env window, an hour before Settings' 07:00.
      await expect(
        service.issueBatch({}, new Date('2026-08-17T22:00:00.000Z')),
      ).rejects.toMatchObject({
        response: { code: 'GYM_CLOSED', details: { nextOpensAt: '2026-08-17T23:00:00.000Z' } },
      });
    });

    it('refuses all day on a day marked closed, pointing at the next open day', async () => {
      const { service, prisma } = build({}, [day(2, '05:00', '22:00', true)]);
      prisma.station.findMany.mockResolvedValue([stationRow()]);

      await expect(service.issueBatch({}, NOON_MANILA)).rejects.toMatchObject({
        response: { code: 'GYM_CLOSED', details: { nextOpensAt: '2026-08-18T21:00:00.000Z' } }, // Wed 05:00
      });
    });

    it('skips a closed tomorrow and uses the next open day’s own opening time', async () => {
      const { service, prisma } = build({}, [
        day(3, '05:00', '22:00', true), // Wednesday closed
        day(4, '06:00', '22:00'), // Thursday opens late
      ]);
      prisma.station.findMany.mockResolvedValue([stationRow()]);

      // Tuesday 22:30 Manila, after closing.
      await expect(
        service.issueBatch({}, new Date('2026-08-18T14:30:00.000Z')),
      ).rejects.toMatchObject({
        response: { code: 'GYM_CLOSED', details: { nextOpensAt: '2026-08-19T22:00:00.000Z' } }, // Thu 06:00
      });
    });

    it('names no opening when every day is marked closed', async () => {
      const allClosed = Array.from({ length: 7 }, (_, d) => day(d, '05:00', '22:00', true));
      const { service, prisma } = build({}, allClosed);
      prisma.station.findMany.mockResolvedValue([stationRow()]);

      const refusal = await service.issueBatch({}, NOON_MANILA).catch((caught: unknown) => caught);
      expect(refusal).toMatchObject({ response: { code: 'GYM_CLOSED' } });
      expect((refusal as { response: { details?: unknown } }).response.details).toBeUndefined();
    });
  });

  describe('station resolution', () => {
    it('a credential-resolved station is used as-is, ignoring any ?station query', async () => {
      const { service, prisma } = build();
      const preResolved = { id: 'x', code: 'ABCD', name: 'X', tokenEpoch: 1, isActive: true };

      const batch = await service.issueBatch(
        { preResolvedStation: preResolved, stationCode: 'ZZZZ' },
        NOON_MANILA,
      );

      expect(batch.station.code).toBe('ABCD');
      expect(prisma.station.findMany).not.toHaveBeenCalled();
      expect(prisma.station.findUnique).not.toHaveBeenCalled();
    });

    it('an inactive credential-resolved station is STATION_INACTIVE', async () => {
      const { service } = build();
      const preResolved = { id: 'x', code: 'ABCD', name: 'X', tokenEpoch: 1, isActive: false };

      await expect(
        service.issueBatch({ preResolvedStation: preResolved }, NOON_MANILA),
      ).rejects.toMatchObject({ response: { code: 'STATION_INACTIVE' } });
    });

    it('an unknown ?station code is STATION_NOT_FOUND', async () => {
      const { service, prisma } = build();
      prisma.station.findUnique.mockResolvedValue(null);

      await expect(service.issueBatch({ stationCode: 'ZZZZ' }, NOON_MANILA)).rejects.toMatchObject({
        response: { code: 'STATION_NOT_FOUND' },
      });
    });

    it('no active stations at all is STATION_NOT_FOUND', async () => {
      const { service, prisma } = build();
      prisma.station.findMany.mockResolvedValue([]);

      await expect(service.issueBatch({}, NOON_MANILA)).rejects.toMatchObject({
        response: { code: 'STATION_NOT_FOUND' },
      });
    });

    it('more than one active station with no ?station is STATION_AMBIGUOUS', async () => {
      const { service, prisma } = build();
      prisma.station.findMany.mockResolvedValue([
        stationRow({ code: 'AAAA' }),
        stationRow({ code: 'BBBB' }),
      ]);

      await expect(service.issueBatch({}, NOON_MANILA)).rejects.toMatchObject({
        response: { code: 'STATION_AMBIGUOUS' },
      });
    });
  });

  describe('the head check', () => {
    it('is fresh when code and tokenEpoch both match', async () => {
      const { service, prisma } = build();
      const station = stationRow();
      prisma.station.findMany.mockResolvedValue([station]);

      const { stale } = await service.checkHead(
        {},
        `${station.code}:${station.tokenEpoch}:59570000`,
      );
      expect(stale).toBe(false);
    });

    it('is stale when tokenEpoch has moved, regardless of the slot component', async () => {
      const { service, prisma } = build();
      const station = stationRow({ tokenEpoch: 2 });
      prisma.station.findMany.mockResolvedValue([station]);

      const { stale } = await service.checkHead({}, `${station.code}:1:59570000`);
      expect(stale).toBe(true);
    });

    it('is stale when the header is missing or malformed', async () => {
      const { service, prisma } = build();
      prisma.station.findMany.mockResolvedValue([stationRow()]);

      expect((await service.checkHead({}, undefined)).stale).toBe(true);
      expect((await service.checkHead({}, 'garbage')).stale).toBe(true);
    });
  });

  describe('batch content', () => {
    it('always starts at the CURRENT slot — polling repeatedly never advances the window', async () => {
      const { service, prisma } = build();
      prisma.station.findMany.mockResolvedValue([stationRow()]);

      const first = await service.issueBatch({}, NOON_MANILA);
      const second = await service.issueBatch({}, new Date(NOON_MANILA.getTime() + 1000));

      expect(first.tokens[0].slot).toBe(second.tokens[0].slot);
    });

    it('signs every token with STATION_TOKEN_SECRET, never the previous secret', async () => {
      const { service, prisma } = build({ STATION_TOKEN_SECRET_PREVIOUS: 'p'.repeat(32) });
      prisma.station.findMany.mockResolvedValue([stationRow()]);

      const batch = await service.issueBatch({}, NOON_MANILA);
      const verifier = new StationTokenService();
      const outcome = verifier.verify({
        payload: batch.tokens[0].payload,
        station: { stationId: stationRow().id, tokenEpoch: 1, isActive: true },
        secrets: ['s'.repeat(32)],
        now: NOON_MANILA,
        slotSeconds: 30,
      });
      expect(outcome.kind).toBe('VALID');
    });
  });
});
