import request from 'supertest';
import { get as httpGet, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { ActiveCheckIn, CheckInResult, DeskTodayPayload, PaginatedData } from '@got/shared';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { seedStationForTest } from './support/station-fixtures';
import { makeMember, seedPlansForTest } from './support/membership-fixtures';
import { StationTokenService } from '../src/checkin/station-token.service';
import { asCivilDate, gymToday } from '../src/common/time/gym-time';

jest.setTimeout(180_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** 18:00 Manila, inside the default 05:00-22:00 hours. */
const EVENING = new Date('2026-08-18T10:00:00.000Z');
const TODAY = gymToday(EVENING, 'Asia/Manila');
const SLOT_SECONDS = 30;

describe('front-desk console (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let tokens: StationTokenService;
  let secret: string;
  let station: { id: string; code: string; tokenEpoch: number };
  let deskToken: string;

  const payloadAt = (at: Date): string => {
    const slot = tokens.computeSlot(at, SLOT_SECONDS);
    const mac = tokens.sign(
      { stationId: station.id, tokenEpoch: station.tokenEpoch },
      slot,
      secret,
    );
    return tokens.buildPayload(station.code, slot, mac);
  };

  /** Puts a real member through the real write path — never a hand-built row. */
  const scanAs = async (memberToken: string, at: Date = EVENING): Promise<void> => {
    await request(server)
      .post('/api/v1/checkin')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ stationToken: payloadAt(at) });
  };

  /**
   * A member leaving, the way they do since 2026-10-20: a second scan offers
   * the check-out and the Check out button confirms it.
   */
  const leaveAs = async (memberToken: string, at: Date): Promise<void> => {
    const offered = await request(server)
      .post('/api/v1/checkin')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ stationToken: payloadAt(at) });
    const checkInId = (offered.body as Envelope<CheckInResult>).data?.checkIn?.id;
    await request(server)
      .post('/api/v1/checkin/checkout')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ checkInId })
      .expect(200);
  };

  const activeMember = async (
    state: Parameters<typeof makeMember>[1]['state'],
  ): Promise<string> => {
    const token = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
    const userId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);
    await makeMember(ctx.prisma, { state, today: asCivilDate(TODAY), userId });
    // `makeMember` only names a user it CREATES; this one was provisioned by
    // the JWT fixture, so the name is set here rather than silently asserted.
    await ctx.prisma.user.update({
      where: { id: userId },
      data: { firstName: 'Ana', lastName: 'Reyes' },
    });
    return token;
  };

  const getToday = async (since?: string): Promise<Envelope<DeskTodayPayload>> => {
    const res = await request(server)
      .get(`/api/v1/front-desk/today${since === undefined ? '' : `?since=${since}`}`)
      .set('Authorization', `Bearer ${deskToken}`);
    return res.body as Envelope<DeskTodayPayload>;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
    tokens = ctx.app.get(StationTokenService, { strict: false });
    secret = process.env['STATION_TOKEN_SECRET'] as string;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await seedPlansForTest(ctx.prisma);
    station = await seedStationForTest(ctx.prisma);
    deskToken = await ctx.fixture.tokenFor('FRONT_DESK', { supabaseId: FIXTURE_IDS.FRONT_DESK });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(EVENING);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Authorisation
  // ───────────────────────────────────────────────────────────────────────

  describe('authorisation', () => {
    /**
     * A CLIENT holds `checkin.self`, never `checkin.read`. This board carries
     * every member currently in the building, with names, codes and photos —
     * it is the single most attractive thing in the API to a curious member.
     */
    it('refuses a member on every desk route', async () => {
      const memberToken = await activeMember('ACTIVE');

      for (const path of ['/api/v1/front-desk/today', '/api/v1/front-desk/check-ins/active']) {
        const res = await request(server).get(path).set('Authorization', `Bearer ${memberToken}`);
        expect(res.status).toBe(403);
      }
    });

    it('refuses an unauthenticated caller', async () => {
      const res = await request(server).get('/api/v1/front-desk/today');
      expect(res.status).toBe(401);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Who is in the building
  // ───────────────────────────────────────────────────────────────────────

  describe('GET /front-desk/check-ins/active', () => {
    it('is empty before anyone arrives', async () => {
      const res = await request(server)
        .get('/api/v1/front-desk/check-ins/active')
        .set('Authorization', `Bearer ${deskToken}`);

      const body = res.body as Envelope<PaginatedData<ActiveCheckIn>>;
      expect(res.status).toBe(200);
      expect(body.data?.items).toEqual([]);
      expect(body.data?.total).toBe(0);
    });

    it('shows an open visit with a live duration', async () => {
      const memberToken = await activeMember('ACTIVE');
      await scanAs(memberToken);

      jest.setSystemTime(new Date(EVENING.getTime() + 14 * 60_000));
      const res = await request(server)
        .get('/api/v1/front-desk/check-ins/active')
        .set('Authorization', `Bearer ${deskToken}`);

      const body = res.body as Envelope<PaginatedData<ActiveCheckIn>>;
      const row = body.data?.items[0];
      expect(row?.member.firstName).toBe('Ana');
      expect(row?.member.planName).toBe('Monthly');
      expect(row?.durationMinutes).toBe(14);
      expect(row?.verdict).toBe('ALLOWED');
      expect(row?.station?.code).toBe(station.code);
    });

    /**
     * The board answers "who does the building think is inside", which is not
     * the same question as "who is inside" — and conflating them is what makes
     * a checked-out member linger on a rail all evening.
     */
    it('drops a member the moment they check out', async () => {
      const memberToken = await activeMember('ACTIVE');
      await scanAs(memberToken);

      const later = new Date(EVENING.getTime() + 40 * 60_000);
      jest.setSystemTime(later);
      const fresh = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
      await leaveAs(fresh, later);

      const res = await request(server)
        .get('/api/v1/front-desk/check-ins/active')
        .set('Authorization', `Bearer ${deskToken}`);
      expect((res.body as Envelope<PaginatedData<ActiveCheckIn>>).data?.items).toEqual([]);
    });

    /**
     * THE PRIVACY BOUNDARY, asserted end to end rather than only on the pure
     * projection. This response streams to a PC in a public lobby.
     */
    it('never puts a contact detail on the lobby board', async () => {
      const memberToken = await activeMember('ACTIVE');
      await scanAs(memberToken);

      const res = await request(server)
        .get('/api/v1/front-desk/check-ins/active')
        .set('Authorization', `Bearer ${deskToken}`);

      const serialised = JSON.stringify(res.body);
      expect(serialised).not.toMatch(/@/); // no email anywhere
      expect(serialised).not.toMatch(/phone/i);
      expect(serialised).not.toMatch(/centavos/i);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // The feed's fallback and catch-up
  // ───────────────────────────────────────────────────────────────────────

  describe('GET /front-desk/today', () => {
    it('reports an empty day with a live station tile', async () => {
      // The display mints a batch, which is the only heartbeat there is.
      await request(server)
        .get('/api/v1/checkin/station-tokens')
        .set('Authorization', `Bearer ${deskToken}`);

      const body = await getToday();
      expect(body.data?.counters).toEqual({ inGym: 0, today: 0, needsYou: 0, manualToday: 0 });
      expect(body.data?.arrivals).toEqual([]);
      expect(body.data?.stations[0].live).toBe(true);
      expect(body.data?.stations[0].code).toBe(station.code);
    });

    it('reports a station that has never minted as dark', async () => {
      const body = await getToday();
      expect(body.data?.stations[0].live).toBe(false);
      expect(body.data?.stations[0].lastTokenIssuedAt).toBeNull();
    });

    it('carries an arrival and moves the counters', async () => {
      const memberToken = await activeMember('ACTIVE');
      await scanAs(memberToken);

      const body = await getToday();
      expect(body.data?.counters.inGym).toBe(1);
      expect(body.data?.counters.today).toBe(1);
      expect(body.data?.arrivals).toHaveLength(1);
      expect(body.data?.arrivals[0].kind).toBe('CHECK_IN');
      expect(body.data?.arrivals[0].member.memberCode).not.toBeNull();
    });

    /**
     * The staff directive, which never travelled to the member's phone. The
     * member was told to see the desk; the desk is told what to sell.
     */
    it('carries a denial with the staff directive, not the member copy', async () => {
      const memberToken = await activeMember('EXPIRED_PAST_GRACE');
      await scanAs(memberToken);

      const body = await getToday();
      expect(body.data?.denials).toHaveLength(1);
      const denial = body.data?.denials[0];
      expect(denial?.reason).toBe('MEMBERSHIP_EXPIRED');
      expect(denial?.outcome).toBe('UNRESOLVED');
      expect(denial?.staffMessage).toMatch(/Renew, or sell a walk-in/);
      // A sellable reason, so it counts against the desk.
      expect(body.data?.counters.needsYou).toBe(1);
    });

    /**
     * GYM_CLOSED, CHECKIN_DAILY_LIMIT and STATION_TOKEN_EXPIRED would sit
     * UNRESOLVED forever and poison the conversion rate — nobody can "resolve"
     * a member who scanned a stale code.
     */
    it('does not count an unsellable denial against the desk', async () => {
      const memberToken = await activeMember('ACTIVE');
      const stale = tokens.computeSlot(EVENING, SLOT_SECONDS) - 4;
      const mac = tokens.sign(
        { stationId: station.id, tokenEpoch: station.tokenEpoch },
        stale,
        secret,
      );

      await request(server)
        .post('/api/v1/checkin')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ stationToken: tokens.buildPayload(station.code, stale, mac) });

      const body = await getToday();
      expect(body.data?.denials).toHaveLength(1);
      expect(body.data?.denials[0].reason).toBe('STATION_TOKEN_EXPIRED');
      expect(body.data?.denials[0].tokenStalenessSeconds).toBe(120);
      expect(body.data?.counters.needsYou).toBe(0);
    });

    /**
     * The cursor keys on `updatedAt`, not `createdAt` — a CHECK-OUT is an
     * UPDATE, and keying on creation makes every departure invisible to a
     * polling console.
     */
    it('returns only what changed since the cursor, including a check-out', async () => {
      const memberToken = await activeMember('ACTIVE');
      await scanAs(memberToken);

      const first = await getToday();
      expect(first.data?.arrivals).toHaveLength(1);

      // Nothing has happened: the same cursor returns an empty page.
      const quiet = await getToday(first.data?.cursor);
      expect(quiet.data?.arrivals).toEqual([]);
      // And it does NOT rewind — a rewound cursor refetches the whole day
      // every three seconds for as long as the gym is quiet.
      expect(quiet.data?.cursor).toBe(first.data?.cursor);

      const later = new Date(EVENING.getTime() + 40 * 60_000);
      jest.setSystemTime(later);
      const fresh = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
      await leaveAs(fresh, later);

      const after = await getToday(first.data?.cursor);
      expect(after.data?.arrivals).toHaveLength(1);
      expect(after.data?.arrivals[0].kind).toBe('CHECK_OUT');
      expect(after.data?.counters.inGym).toBe(0);
    });

    /**
     * This cursor round-trips through a console that has been open since 06:00
     * and may carry a value from a previous deploy. A 400 blanks the desk
     * board mid-shift; a full payload self-heals on the next poll.
     */
    it('ignores a malformed cursor rather than blanking the board', async () => {
      const memberToken = await activeMember('ACTIVE');
      await scanAs(memberToken);

      const body = await getToday('not-a-timestamp');
      expect(body.success).toBe(true);
      expect(body.data?.arrivals).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // The live feed
  // ───────────────────────────────────────────────────────────────────────

  describe('GET /front-desk/stream', () => {
    /**
     * nginx and most PaaS routers buffer a streaming response by default, so
     * events arrive in batches when the buffer flushes — which on a quiet
     * evening means a denial reaches the desk minutes after the member walked
     * away. This header is the only way to turn that off from inside the app,
     * and its absence fails completely silently.
     */
    it('sets the headers that stop an intermediary buffering the feed', async () => {
      // REAL timers for this one. The connection is designed never to end, so
      // the test has to abort it itself — and every abort mechanism available
      // (socket timeouts, setTimeout) is frozen while jest's fake clock is
      // installed, which turns this assertion into a hung suite.
      jest.useRealTimers();

      // Nest's test server binds a fresh ephemeral port per supertest request
      // and is otherwise NOT listening, so `server.address()` is null until we
      // bind it ourselves. SSE needs a real long-lived socket, so it does.
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const { port } = server.address() as AddressInfo;

      const headers = await new Promise<Record<string, string | string[] | undefined>>(
        (resolve, reject) => {
          const req = httpGet(
            {
              port,
              path: '/api/v1/front-desk/stream',
              headers: { Authorization: `Bearer ${deskToken}` },
            },
            (res) => {
              const captured = res.headers;
              // Hang up as soon as the headers land: this response has no end.
              res.destroy();
              req.destroy();
              resolve(captured);
            },
          );
          req.on('error', reject);
        },
      ).finally(() => new Promise<void>((resolve) => server.close(() => resolve())));

      expect(headers['content-type']).toMatch(/text\/event-stream/);
      expect(headers['x-accel-buffering']).toBe('no');
      expect(headers['cache-control']).toMatch(/no-cache/);
    });

    it('refuses a member', async () => {
      const memberToken = await activeMember('ACTIVE');
      const res = await request(server)
        .get('/api/v1/front-desk/stream')
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
    });
  });
});
