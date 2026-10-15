import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { seedStationForTest } from './support/station-fixtures';
import type { AdminStation, IssuedStationCredential } from '../src/admin/station.presenter';

jest.setTimeout(180_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

describe('admin stations (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let adminToken: string;

  const asAdmin = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    request(server)[method](`/api/v1${path}`).set('Authorization', `Bearer ${adminToken}`);

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
  });

  describe('authorisation', () => {
    /**
     * `station.manage` is ADMIN-only and isDangerous. Two of its three actions
     * take a check-in point offline — one instantly, for every member already
     * walking towards it.
     */
    it('refuses front desk and members alike', async () => {
      for (const role of ['FRONT_DESK', 'CLIENT'] as const) {
        const token = await ctx.fixture.tokenFor(role, {
          supabaseId: role === 'FRONT_DESK' ? FIXTURE_IDS.FRONT_DESK : FIXTURE_IDS.CLIENT_A,
        });
        const res = await request(server)
          .get('/api/v1/admin/stations')
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
      }
    });
  });

  describe('GET /admin/stations', () => {
    it('lists stations with their credentials and lifetime visit count', async () => {
      const station = await seedStationForTest(ctx.prisma);

      const res = await asAdmin('get', '/admin/stations');
      const body = res.body as Envelope<AdminStation[]>;

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(1);
      expect(body.data?.[0]).toMatchObject({
        id: station.id,
        code: station.code,
        name: 'Front desk',
        tokenEpoch: 1,
        isActive: true,
        checkInCount: 0,
        credentials: [],
      });
    });
  });

  describe('POST /admin/stations/:id/credentials', () => {
    /**
     * THE SECRET IS SHOWN ONCE. A recoverable station key is a key that sits
     * in a database anyone with `station.manage` can read at leisure, on an
     * account also used for day-to-day admin. Losing it costs one revoke and
     * one re-provision — about a minute.
     */
    it('returns the plaintext once and stores only a hash', async () => {
      const station = await seedStationForTest(ctx.prisma);

      const res = await asAdmin('post', `/admin/stations/${station.id}/credentials`)
        .set('Idempotency-Key', '11111111-1111-4111-8111-111111111111')
        .send({ label: 'Front desk tablet' });

      const body = res.body as Envelope<IssuedStationCredential>;
      expect(res.status).toBe(201);
      expect(body.data?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.data?.stationCode).toBe(station.code);

      const stored = await ctx.prisma.stationCredential.findFirstOrThrow();
      expect(stored.keyHash).toMatch(/^[0-9a-f]{64}$/);
      // The plaintext appears nowhere on the row.
      expect(JSON.stringify(stored)).not.toContain(body.data?.secret as string);
    });

    it('never returns the hash to an admin on a later read', async () => {
      const station = await seedStationForTest(ctx.prisma);
      await asAdmin('post', `/admin/stations/${station.id}/credentials`)
        .set('Idempotency-Key', '22222222-2222-4222-8222-222222222222')
        .send({ label: 'Front desk tablet' });

      const res = await asAdmin('get', '/admin/stations');
      // A hash plus a known pepper is an offline guessing target, and it
      // answers no operational question.
      expect(JSON.stringify(res.body)).not.toMatch(/keyHash|lastUsedIpHash/);
    });

    /** The issued key must actually work on the display's own endpoint. */
    it('issues a key the station-token endpoint accepts', async () => {
      const station = await seedStationForTest(ctx.prisma);
      const issued = await asAdmin('post', `/admin/stations/${station.id}/credentials`)
        .set('Idempotency-Key', '33333333-3333-4333-8333-333333333333')
        .send({ label: 'Front desk tablet' });

      const secret = (issued.body as Envelope<IssuedStationCredential>).data?.secret as string;

      const res = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('X-Station-Key', secret);

      expect(res.status).toBe(200);
      expect((res.body as Envelope<{ station: { code: string } }>).data?.station.code).toBe(
        station.code,
      );
    });

    it('404s for a station that does not exist', async () => {
      const res = await asAdmin(
        'post',
        '/admin/stations/00000000-0000-4000-8000-000000000000/credentials',
      )
        .set('Idempotency-Key', '44444444-4444-4444-8444-444444444444')
        .send({ label: 'Ghost' });

      expect(res.status).toBe(404);
      expect((res.body as Envelope<never>).error?.code).toBe('STATION_NOT_FOUND');
    });
  });

  describe('DELETE /admin/stations/credentials/:id', () => {
    it('revokes the key and the display stops working immediately', async () => {
      const station = await seedStationForTest(ctx.prisma);
      const issued = await asAdmin('post', `/admin/stations/${station.id}/credentials`)
        .set('Idempotency-Key', '55555555-5555-4555-8555-555555555555')
        .send({ label: 'Stolen tablet' });
      const { secret, credential } = (issued.body as Envelope<IssuedStationCredential>)
        .data as IssuedStationCredential;

      expect(
        (await request(server).get('/api/v1/checkin/station-tokens').set('X-Station-Key', secret))
          .status,
      ).toBe(200);

      await asAdmin('delete', `/admin/stations/credentials/${credential.id}`).expect(200);

      expect(
        (await request(server).get('/api/v1/checkin/station-tokens').set('X-Station-Key', secret))
          .status,
      ).toBe(401);
    });

    /**
     * Revoke, never delete: the row is what answers "which tablet was this,
     * who provisioned it, when did we turn it off" — questions that only get
     * asked after something has gone wrong.
     */
    it('keeps the row so the audit trail survives', async () => {
      const station = await seedStationForTest(ctx.prisma);
      const issued = await asAdmin('post', `/admin/stations/${station.id}/credentials`)
        .set('Idempotency-Key', '66666666-6666-4666-8666-666666666666')
        .send({ label: 'Spare' });
      const credentialId = (issued.body as Envelope<IssuedStationCredential>).data?.credential
        .id as string;

      await asAdmin('delete', `/admin/stations/credentials/${credentialId}`).expect(200);

      const row = await ctx.prisma.stationCredential.findUniqueOrThrow({
        where: { id: credentialId },
      });
      expect(row.revokedAt).not.toBeNull();
      expect(row.label).toBe('Spare');
    });

    /** A double-tap on a panicked click must not answer 404. */
    it('is idempotent', async () => {
      const station = await seedStationForTest(ctx.prisma);
      const issued = await asAdmin('post', `/admin/stations/${station.id}/credentials`)
        .set('Idempotency-Key', '77777777-7777-4777-8777-777777777777')
        .send({ label: 'Spare' });
      const credentialId = (issued.body as Envelope<IssuedStationCredential>).data?.credential
        .id as string;

      const first = await asAdmin('delete', `/admin/stations/credentials/${credentialId}`);
      const second = await asAdmin('delete', `/admin/stations/credentials/${credentialId}`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((second.body as Envelope<{ revokedAt: string }>).data?.revokedAt).toBe(
        (first.body as Envelope<{ revokedAt: string }>).data?.revokedAt,
      );
    });
  });

  describe('PATCH /admin/stations/:id', () => {
    /**
     * THE OFF SWITCH. "That tablet was stolen" and "that entrance is shut" are
     * a database write, not a redeploy — and with a config list the only lever
     * would be rotating the global secret, which kills every station at once.
     */
    it('deactivates a station and the token endpoint refuses it', async () => {
      const station = await seedStationForTest(ctx.prisma);
      const issued = await asAdmin('post', `/admin/stations/${station.id}/credentials`)
        .set('Idempotency-Key', '88888888-8888-4888-8888-888888888888')
        .send({ label: 'Front desk tablet' });
      const secret = (issued.body as Envelope<IssuedStationCredential>).data?.secret as string;

      await asAdmin('patch', `/admin/stations/${station.id}`).send({ isActive: false }).expect(200);

      const res = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('X-Station-Key', secret);
      expect(res.status).toBe(409);
      expect((res.body as Envelope<never>).error?.code).toBe('STATION_INACTIVE');
    });

    /**
     * THE PER-STATION PANIC BUTTON. Every outstanding token for THIS station
     * dies within one slot — and the head check is what makes it one slot
     * rather than one batch.
     */
    it('bumps the token epoch by exactly one and staleness is reported', async () => {
      const station = await seedStationForTest(ctx.prisma);
      const issued = await asAdmin('post', `/admin/stations/${station.id}/credentials`)
        .set('Idempotency-Key', '99999999-9999-4999-8999-999999999999')
        .send({ label: 'Front desk tablet' });
      const secret = (issued.body as Envelope<IssuedStationCredential>).data?.secret as string;

      const batch = await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('X-Station-Key', secret);
      const etag = (batch.body as Envelope<{ batchEtag: string }>).data?.batchEtag as string;

      // Before the bump the display's cache is still good.
      await request(server)
        .get('/api/v1/checkin/station-tokens/head')
        .set('X-Station-Key', secret)
        .set('If-None-Match', etag)
        .expect(204);

      const patched = await asAdmin('patch', `/admin/stations/${station.id}`)
        .send({ bumpTokenEpoch: true })
        .expect(200);
      expect((patched.body as Envelope<AdminStation>).data?.tokenEpoch).toBe(2);

      // After it, the display is told to discard on its very next poll.
      const head = await request(server)
        .get('/api/v1/checkin/station-tokens/head')
        .set('X-Station-Key', secret)
        .set('If-None-Match', etag);
      expect(head.status).toBe(409);
      expect((head.body as Envelope<never>).error?.code).toBe('STATION_BATCH_STALE');
    });

    /**
     * `code` is CSPRNG-allocated once and physically printed on a label under
     * the screen. An editable code invalidates that label without anyone
     * touching the tablet, so the DTO rejects the field outright rather than
     * ignoring it.
     */
    it('refuses to edit the printed station code', async () => {
      const station = await seedStationForTest(ctx.prisma);
      const res = await asAdmin('patch', `/admin/stations/${station.id}`).send({ code: 'ZZZZ' });

      expect(res.status).toBe(400);
      const after = await ctx.prisma.station.findUniqueOrThrow({ where: { id: station.id } });
      expect(after.code).toBe(station.code);
    });

    it('404s for a station that does not exist', async () => {
      const res = await asAdmin(
        'patch',
        '/admin/stations/00000000-0000-4000-8000-000000000000',
      ).send({ name: 'Ghost' });
      expect(res.status).toBe(404);
    });
  });
});
