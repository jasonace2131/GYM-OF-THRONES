import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { createStationCredentialForTest, seedStationForTest } from './support/station-fixtures';
import { StationTokenService } from '../src/checkin/station-token.service';

jest.setTimeout(120_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

interface StationTokenBatch {
  station: { id: string; code: string; name: string };
  slotSeconds: number;
  serverTime: string;
  tokenEpoch: number;
  openUntil: string;
  batchEtag: string;
  tokens: Array<{ slot: number; notBefore: string; notAfter: string; payload: string }>;
}

/**
 * Anchored at a fixed instant safely inside the gym's default hours
 * (05:00-22:00 Asia/Manila, per `.env.example`) — 2026-08-18T04:00:00.000Z is
 * 12:00 noon Manila. Every request in this file runs under this fake clock so
 * the suite's pass/fail never depends on the real wall-clock time the CI
 * runner happens to execute at. The gym-hours GATE itself (closed-window
 * behaviour, `nextOpensAt`) is unit-tested in `station-tokens.service.spec.ts`
 * against an explicitly injected open/close time, not here.
 */
const OPEN_HOURS_INSTANT = new Date('2026-08-18T04:00:00.000Z');

async function seedAdminId(ctx: TestApp): Promise<string> {
  await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
  return ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
}

describe('checkin/station-tokens (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let pepper: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
    pepper = process.env['STATION_CREDENTIAL_PEPPER'] as string;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
      .setSystemTime(OPEN_HOURS_INSTANT);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('X-Station-Key credential auth', () => {
    it("issues a batch of STATION_TOKEN_BATCH_SIZE tokens for the credential's own station", async () => {
      const adminId = await seedAdminId(ctx);
      const station = await seedStationForTest(ctx.prisma);
      const key = await createStationCredentialForTest(ctx.prisma, {
        stationId: station.id,
        createdById: adminId,
        pepper,
      });

      const res = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('X-Station-Key', key);

      expect(res.status).toBe(200);
      const body = (res.body as Envelope<StationTokenBatch>).data as StationTokenBatch;
      expect(body.station).toEqual({ id: station.id, code: station.code, name: station.name });
      expect(body.tokenEpoch).toBe(1);
      expect(body.tokens.length).toBe(10); // STATION_TOKEN_BATCH_SIZE default
      expect(body.tokens[0].payload).toMatch(/^GOTS1\./);
      // Consecutive slots, starting at the current one — never pre-minted runway.
      expect(body.tokens[1].slot).toBe(body.tokens[0].slot + 1);
    });

    it('rejects an unknown or revoked key with the SAME message as a missing Authorization header', async () => {
      const res = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('X-Station-Key', 'not-a-real-key');

      expect(res.status).toBe(401);
    });

    it('a revoked credential is rejected', async () => {
      const adminId = await seedAdminId(ctx);
      const station = await seedStationForTest(ctx.prisma);
      const key = await createStationCredentialForTest(ctx.prisma, {
        stationId: station.id,
        createdById: adminId,
        pepper,
      });
      await ctx.prisma.stationCredential.updateMany({
        where: { stationId: station.id },
        data: { revokedAt: new Date() },
      });

      const res = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('X-Station-Key', key);

      expect(res.status).toBe(401);
    });

    it('an inactive station reports 409 STATION_INACTIVE even with a valid credential', async () => {
      const adminId = await seedAdminId(ctx);
      const station = await seedStationForTest(ctx.prisma, { isActive: false });
      const key = await createStationCredentialForTest(ctx.prisma, {
        stationId: station.id,
        createdById: adminId,
        pepper,
      });

      const res = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('X-Station-Key', key);

      expect(res.status).toBe(409);
      expect((res.body as Envelope<never>).error?.code).toBe('STATION_INACTIVE');
    });
  });

  describe('checkin.station_token.issue staff fallback', () => {
    it('ADMIN can preview the one active station with no ?station param', async () => {
      const adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
      const station = await seedStationForTest(ctx.prisma);

      const res = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect((res.body as Envelope<StationTokenBatch>).data?.station.id).toBe(station.id);
    });

    it('FRONT_DESK holds the same key and can also preview', async () => {
      const frontDeskToken = await ctx.fixture.tokenFor('FRONT_DESK', {
        supabaseId: FIXTURE_IDS.FRONT_DESK,
      });
      await seedStationForTest(ctx.prisma);

      const res = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('Authorization', `Bearer ${frontDeskToken}`);

      expect(res.status).toBe(200);
    });

    it('CLIENT lacks the permission and is rejected', async () => {
      const clientToken = await ctx.fixture.tokenFor('CLIENT', {
        supabaseId: FIXTURE_IDS.CLIENT_A,
      });
      await seedStationForTest(ctx.prisma);

      const res = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('Authorization', `Bearer ${clientToken}`);

      expect(res.status).toBe(403);
    });

    it('an unknown ?station=<code> is 404 STATION_NOT_FOUND', async () => {
      const adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
      await seedStationForTest(ctx.prisma);

      const res = await request(server)
        .get('/api/v1/checkin/station-tokens?station=ZZZZ')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect((res.body as Envelope<never>).error?.code).toBe('STATION_NOT_FOUND');
    });

    it('two active stations with no ?station param is 409 STATION_AMBIGUOUS', async () => {
      const adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
      await seedStationForTest(ctx.prisma, { code: 'AAAA' });
      await seedStationForTest(ctx.prisma, { code: 'BBBB' });

      const res = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(409);
      expect((res.body as Envelope<never>).error?.code).toBe('STATION_AMBIGUOUS');
    });

    it('?station=<code> disambiguates when two stations are active', async () => {
      const adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
      await seedStationForTest(ctx.prisma, { code: 'AAAA' });
      const stationB = await seedStationForTest(ctx.prisma, { code: 'BBBB' });

      const res = await request(server)
        .get('/api/v1/checkin/station-tokens?station=BBBB')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect((res.body as Envelope<StationTokenBatch>).data?.station.id).toBe(stationB.id);
    });
  });

  describe('the head check (§6.2.3)', () => {
    it('204s when the cached batchEtag still matches the current tokenEpoch', async () => {
      const adminId = await seedAdminId(ctx);
      const station = await seedStationForTest(ctx.prisma);
      const key = await createStationCredentialForTest(ctx.prisma, {
        stationId: station.id,
        createdById: adminId,
        pepper,
      });

      const full = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('X-Station-Key', key);
      const etag = (full.body as Envelope<StationTokenBatch>).data?.batchEtag as string;

      const head = await request(server)
        .get('/api/v1/checkin/station-tokens/head')
        .set('X-Station-Key', key)
        .set('If-None-Match', etag);

      expect(head.status).toBe(204);
    });

    it('409 STATION_BATCH_STALE the instant tokenEpoch is bumped — the panic button', async () => {
      const adminId = await seedAdminId(ctx);
      const station = await seedStationForTest(ctx.prisma);
      const key = await createStationCredentialForTest(ctx.prisma, {
        stationId: station.id,
        createdById: adminId,
        pepper,
      });

      const full = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('X-Station-Key', key);
      const etag = (full.body as Envelope<StationTokenBatch>).data?.batchEtag as string;

      // The tablet is reported stolen: bump the epoch.
      await ctx.prisma.station.update({ where: { id: station.id }, data: { tokenEpoch: 2 } });

      const head = await request(server)
        .get('/api/v1/checkin/station-tokens/head')
        .set('X-Station-Key', key)
        .set('If-None-Match', etag);

      expect(head.status).toBe(409);
      expect((head.body as Envelope<never>).error?.code).toBe('STATION_BATCH_STALE');

      // And the tokens the stolen tablet had cached before the bump genuinely
      // no longer verify — the head check is a UX nudge; THIS is the actual
      // security property (§6.1.2: verification never tries epoch − 1).
      const staleToken = (full.body as Envelope<StationTokenBatch>).data?.tokens[0]
        .payload as string;
      const tokens = ctx.app.get(StationTokenService);
      const bumpedStation = await ctx.prisma.station.findUniqueOrThrow({
        where: { id: station.id },
      });
      const secret = process.env['STATION_TOKEN_SECRET'] as string;
      const outcome = tokens.verify({
        payload: staleToken,
        station: {
          stationId: bumpedStation.id,
          tokenEpoch: bumpedStation.tokenEpoch,
          isActive: bumpedStation.isActive,
        },
        secrets: [secret],
        now: OPEN_HOURS_INSTANT,
        slotSeconds: 30,
      });
      expect(outcome.kind).toBe('INVALID');
    });

    it('a missing or malformed If-None-Match is treated as stale, never as a 5xx', async () => {
      const adminId = await seedAdminId(ctx);
      const station = await seedStationForTest(ctx.prisma);
      const key = await createStationCredentialForTest(ctx.prisma, {
        stationId: station.id,
        createdById: adminId,
        pepper,
      });

      const head = await request(server)
        .get('/api/v1/checkin/station-tokens/head')
        .set('X-Station-Key', key);

      expect(head.status).toBe(409);
    });
  });

  describe('the batch never advances by being asked (§6.15)', () => {
    it('polling repeatedly at the same instant returns the identical leading slot', async () => {
      const adminId = await seedAdminId(ctx);
      const station = await seedStationForTest(ctx.prisma);
      const key = await createStationCredentialForTest(ctx.prisma, {
        stationId: station.id,
        createdById: adminId,
        pepper,
      });

      const first = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('X-Station-Key', key);
      const second = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('X-Station-Key', key);

      const firstSlot = (first.body as Envelope<StationTokenBatch>).data?.tokens[0].slot;
      const secondSlot = (second.body as Envelope<StationTokenBatch>).data?.tokens[0].slot;
      expect(firstSlot).toBe(secondSlot);
    });
  });
});
