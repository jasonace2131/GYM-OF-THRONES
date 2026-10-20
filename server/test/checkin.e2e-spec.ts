import request from 'supertest';
import type { Server } from 'http';
import type { CheckInResult, CheckInStatus } from '@got/shared';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { seedStationForTest } from './support/station-fixtures';
import { makeMember, seedPlansForTest } from './support/membership-fixtures';
import { StationTokenService } from '../src/checkin/station-token.service';
import { asCivilDate, gymToday, toDateColumn } from '../src/common/time/gym-time';

jest.setTimeout(180_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

/**
 * 2026-08-18T10:00:00.000Z is 18:00 Manila — comfortably inside the default
 * gym hours (05:00-22:00) and in the evening peak this design is sized for.
 * Every request runs under this fake clock so the suite never depends on the
 * wall-clock time CI happens to run at.
 */
const EVENING = new Date('2026-08-18T10:00:00.000Z');
const TZ = 'Asia/Manila';
const TODAY = gymToday(EVENING, TZ);
const SLOT_SECONDS = 30;

describe('POST /api/v1/checkin (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let tokens: StationTokenService;
  let secret: string;
  let station: { id: string; code: string; tokenEpoch: number };

  /** Signs a payload the way a station display would have rendered it. */
  const payloadFor = (at: Date = new Date(), stationOverride?: typeof station): string => {
    const target = stationOverride ?? station;
    const slot = tokens.computeSlot(at, SLOT_SECONDS);
    const mac = tokens.sign({ stationId: target.id, tokenEpoch: target.tokenEpoch }, slot, secret);
    return tokens.buildPayload(target.code, slot, mac);
  };

  const payloadForSlot = (slot: number): string => {
    const mac = tokens.sign(
      { stationId: station.id, tokenEpoch: station.tokenEpoch },
      slot,
      secret,
    );
    return tokens.buildPayload(station.code, slot, mac);
  };

  const scan = async (token: string, payload: string): Promise<Envelope<CheckInResult>> => {
    const res = await request(server)
      .post('/api/v1/checkin')
      .set('Authorization', `Bearer ${token}`)
      .send({ stationToken: payload });
    return res.body as Envelope<CheckInResult>;
  };

  /** The Check out button: `POST /checkin/checkout` with the visit id. */
  const confirmOut = async (
    token: string,
    checkInId: string,
  ): Promise<{ status: number; body: Envelope<CheckInResult> }> => {
    const res = await request(server)
      .post('/api/v1/checkin/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ checkInId });
    return { status: res.status, body: res.body as Envelope<CheckInResult> };
  };

  /**
   * How a member leaves since 2026-10-20: a second scan offers the check-out
   * (ALREADY_INSIDE) and the button confirms it. Neither half alone closes
   * the visit.
   */
  const leave = async (token: string, at: Date): Promise<Envelope<CheckInResult>> => {
    const offered = await scan(token, payloadFor(at));
    expect(offered.data?.outcome).toBe('ALREADY_INSIDE');
    return (await confirmOut(token, offered.data!.checkIn!.id)).body;
  };

  /**
   * Moves the fake clock AND re-mints the caller's token.
   *
   * Fixture JWTs expire after an hour, so a test that jumps four hours to
   * exercise the stale-visit rule would otherwise fail at AuthGuard with a 401
   * and prove nothing about attendance. Re-minting is the honest fix: in
   * production a member returning four hours later is holding a refreshed
   * session, not a four-hour-old access token.
   */
  const advanceTo = async (at: Date, role: 'CLIENT' | 'COACH' = 'CLIENT'): Promise<string> => {
    jest.setSystemTime(at);
    return ctx.fixture.tokenFor(role, {
      supabaseId: role === 'CLIENT' ? FIXTURE_IDS.CLIENT_A : FIXTURE_IDS.COACH_A,
    });
  };

  /** A CLIENT fixture whose JWT is already minted and whose row is in a known state. */
  const client = async (
    state: Parameters<typeof makeMember>[1]['state'],
  ): Promise<{ token: string; userId: string }> => {
    const token = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
    const userId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);
    await makeMember(ctx.prisma, { state, today: asCivilDate(TODAY), userId });
    return { token, userId };
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
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(EVENING);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Admission
  // ───────────────────────────────────────────────────────────────────────

  describe('the happy path', () => {
    it('admits an active member and writes one open visit', async () => {
      const { token, userId } = await client('ACTIVE');

      const body = await scan(token, payloadFor());

      expect(body.success).toBe(true);
      expect(body.data?.outcome).toBe('CHECKED_IN');
      expect(body.data?.replayed).toBe(false);
      expect(body.data?.display.tone).toBe('WELCOME');
      expect(body.data?.checkIn?.verdict).toBe('ALLOWED');
      expect(body.data?.checkIn?.visitNumberThisMonth).toBe(1);
      expect(body.data?.denial).toBeNull();
      expect(body.data?.station).toEqual({ code: station.code, name: 'Front desk' });

      const row = await ctx.prisma.checkIn.findUniqueOrThrow({ where: { openUserId: userId } });
      expect(row.entryType).toBe('MEMBERSHIP');
      expect(row.method).toBe('STATION_QR');
      expect(row.stationId).toBe(station.id);
      expect(row.endedAt).toBeNull();
      // NULL on a self-scan: nobody recorded it, the accountable party is the
      // member. Biconditional with method = STATION_QR, enforced by CHECK.
      expect(row.recordedById).toBeNull();
      // Best-effort, and no shift is open in this test — a member self-scan
      // must never be blocked on staff having opened the drawer.
      expect(row.shiftId).toBeNull();
    });

    it('claims the slot and stores the rendered body on the scan row', async () => {
      const { token, userId } = await client('ACTIVE');
      const payload = payloadFor();

      const body = await scan(token, payload);

      const claim = await ctx.prisma.stationScan.findFirstOrThrow({ where: { userId } });
      expect(claim.outcome).toBe('CHECKED_IN');
      expect(claim.checkInId).toBe(body.data?.checkIn?.id);
      expect(claim.denialId).toBeNull();
      expect(claim.responseSnapshot).not.toBeNull();
    });

    it('records the origin hash without ever storing a raw IP', async () => {
      const { token, userId } = await client('ACTIVE');
      await scan(token, payloadFor());

      const row = await ctx.prisma.checkIn.findUniqueOrThrow({ where: { openUserId: userId } });
      expect(row.originIpHash).toMatch(/^[0-9a-f]{64}$/);
      // GYM_EGRESS_CIDRS is empty in test config, so everything reads off-site.
      // That degrades the signal to noise and denies nobody — which is the
      // entire contract of this column.
      expect(row.offSiteOrigin).toBe(true);
    });
  });

  describe('grace', () => {
    it('admits in grace, stores ALLOWED_IN_GRACE and counts the admission', async () => {
      const { token, userId } = await client('IN_GRACE');

      const body = await scan(token, payloadFor());

      expect(body.data?.outcome).toBe('CHECKED_IN');
      // The door opened, and the card says so FIRST. Pretending otherwise
      // would be a lie about what just happened.
      expect(body.data?.display.tone).toBe('GRACE');
      expect(body.data?.checkIn?.verdict).toBe('ALLOWED_IN_GRACE');
      expect(body.data?.nextStep?.kind).toBe('RENEW_AT_DESK');

      // Grace is FINITE and COUNTED, and the bound lives on the membership row
      // so it holds whether or not the nightly job ever runs again.
      const membership = await ctx.prisma.membership.findUniqueOrThrow({ where: { userId } });
      expect(membership.graceAdmissionsThisTerm).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Replay and concurrency — §6.11.1
  // ───────────────────────────────────────────────────────────────────────

  describe('replay', () => {
    it('returns the identical stored body with replayed:true and writes no second row', async () => {
      const { token, userId } = await client('ACTIVE');
      const payload = payloadFor();

      const first = await scan(token, payload);
      const second = await scan(token, payload);

      expect(second.data?.replayed).toBe(true);
      // Verbatim, not recomputed: `membership` and `visitNumberThisMonth`
      // legitimately change between two presentations of one code, and the
      // phone's decode loop paints the second over the first.
      expect({ ...second.data, replayed: false }).toEqual(first.data);

      expect(await ctx.prisma.checkIn.count({ where: { userId } })).toBe(1);
      expect(await ctx.prisma.stationScan.count({ where: { userId } })).toBe(1);
    });

    it('replays a DENIAL without writing a second denial row', async () => {
      const { token, userId } = await client('EXPIRED_PAST_GRACE');
      const payload = payloadFor();

      const first = await scan(token, payload);
      const second = await scan(token, payload);

      expect(first.data?.outcome).toBe('DENIED');
      expect(second.data?.replayed).toBe(true);
      expect(second.data?.denial?.id).toBe(first.data?.denial?.id);
      expect(await ctx.prisma.checkInDenial.count({ where: { userId } })).toBe(1);
    });
  });

  /**
   * THE CASE A SAME-TOKEN TEST CANNOT SEE. Two devices signed into one account
   * presenting DIFFERENT slots do not collide on `StationScan` at all — both
   * reach the admit path, and both insert a `CheckIn` with the same
   * `openUserId`. Without `createMany({ skipDuplicates: true })` that is a raw
   * 23505 that 500s a member at the counter. The realistic trigger is mundane:
   * a phone and a tablet on one account, or a first request that stalls and a
   * member who scans again after the slot rolls.
   */
  describe('two devices, one account, adjacent slots', () => {
    it('admits once and answers ALREADY_INSIDE to the second, never a 500', async () => {
      const { token, userId } = await client('ACTIVE');
      const currentSlot = tokens.computeSlot(EVENING, SLOT_SECONDS);

      const first = await scan(token, payloadForSlot(currentSlot));
      const second = await scan(token, payloadForSlot(currentSlot - 1));

      expect(first.data?.outcome).toBe('CHECKED_IN');
      expect(second.success).toBe(true);
      expect(second.data?.outcome).toBe('ALREADY_INSIDE');
      expect(second.data?.replayed).toBe(false);
      // Neutral, not an error: it is a no-op, not a failure.
      expect(second.data?.display.tone).toBe('WELCOME');
      expect(second.data?.display.detail).toBe('Leaving? Check out below.');

      expect(await ctx.prisma.checkIn.count({ where: { userId } })).toBe(1);
      // Both slots were consumed by presentation, which is the point of
      // claiming before the verdict.
      expect(await ctx.prisma.stationScan.count({ where: { userId } })).toBe(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Check-out, staleness, re-entry — §6.6
  // ───────────────────────────────────────────────────────────────────────

  describe('the second scan', () => {
    /**
     * A second scan never checks anyone out by itself (owner, 2026-10-20) —
     * not at one minute, not at an hour and a half. It offers the check-out,
     * and links the scan to the visit so the button can use it as proof.
     */
    it.each([1, 86])('is ALREADY_INSIDE %i minutes in, and closes nothing', async (minutes) => {
      const { token, userId } = await client('ACTIVE');
      await scan(token, payloadForSlot(tokens.computeSlot(EVENING, SLOT_SECONDS)));

      const later = new Date(EVENING.getTime() + minutes * 60_000);
      const fresh = await advanceTo(later);
      const body = await scan(fresh, payloadFor(later));

      expect(body.data?.outcome).toBe('ALREADY_INSIDE');
      expect(body.data?.display.headline).toBe("You're already in.");
      expect(body.data?.display.detail).toBe('Leaving? Check out below.');

      const row = await ctx.prisma.checkIn.findUniqueOrThrow({ where: { openUserId: userId } });
      expect(row.endedAt).toBeNull();
      expect(body.data?.checkIn?.id).toBe(row.id);

      const proof = await ctx.prisma.stationScan.findFirstOrThrow({
        where: { userId, outcome: 'ALREADY_INSIDE' },
      });
      expect(proof.checkInId).toBe(row.id);
    });

    it('checks out when the member confirms, before the stale window', async () => {
      const { token, userId } = await client('ACTIVE');
      await scan(token, payloadForSlot(tokens.computeSlot(EVENING, SLOT_SECONDS)));

      const later = new Date(EVENING.getTime() + 86 * 60_000);
      const fresh = await advanceTo(later);
      const body = await leave(fresh, later);

      expect(body.data?.outcome).toBe('CHECKED_OUT');
      // Slate, never green — a check-out must not read as an admission.
      expect(body.data?.display.tone).toBe('GOODBYE');
      expect(body.data?.session?.durationMinutes).toBe(86);

      const row = await ctx.prisma.checkIn.findFirstOrThrow({ where: { userId } });
      expect(row.endedAt).not.toBeNull();
      expect(row.closeMethod).toBe('STATION_QR');
      expect(row.openUserId).toBeNull();
      expect(row.closeStationId).toBe(station.id);
      // Excluded from duration statistics only for AUTO_CLOSE / STALE_CLOSE.
      expect(row.autoClosed).toBe(false);
    });

    /**
     * The latent 24-hour bug this rule closes: the nightly job's predicate is
     * `businessDate < today`, so MONDAY's open visits survive until TUESDAY
     * 22:15. A member who checks in Monday 06:00, forgets to scan out and
     * scans Tuesday 06:00 would otherwise receive a check-out with a 24-hour
     * session.
     */
    it('stale-closes a visit carrying an earlier business date and opens a new one', async () => {
      const { token, userId } = await client('ACTIVE');
      await scan(token, payloadForSlot(tokens.computeSlot(EVENING, SLOT_SECONDS)));

      // Backdate the open visit to yesterday, exactly as an unclosed visit
      // survives the nightly job's own predicate.
      const yesterday = asCivilDate('2026-08-17');
      await ctx.prisma.checkIn.updateMany({
        where: { openUserId: userId },
        data: {
          businessDate: toDateColumn(yesterday),
          occurredAt: new Date(EVENING.getTime() - 24 * 60 * 60_000),
        },
      });

      // A minute later, so the second scan presents a DIFFERENT slot. Re-using
      // the first slot would take the replay path and prove nothing about
      // staleness — the mistake this comment exists to stop the next reader
      // making.
      const nextMinute = new Date(EVENING.getTime() + 60_000);
      jest.setSystemTime(nextMinute);
      const body = await scan(token, payloadFor(nextMinute));

      expect(body.data?.outcome).toBe('RECHECKED_IN');
      expect(body.data?.display.tone).toBe('WELCOME');

      const rows = await ctx.prisma.checkIn.findMany({
        where: { userId },
        orderBy: { occurredAt: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0].closeMethod).toBe('STALE_CLOSE');
      // Excluded from every duration statistic exactly like an auto-closed row.
      expect(rows[0].autoClosed).toBe(true);
      // CheckIn_close_station_shape: a close station belongs only to a real
      // STATION_QR check-out. A stale close is the server noticing.
      expect(rows[0].closeStationId).toBeNull();
      expect(rows[1].endedAt).toBeNull();
      expect(rows[1].openUserId).toBe(userId);
    });

    it('stale-closes a visit older than CHECKIN_STALE_VISIT_HOURS on the same day', async () => {
      const { token, userId } = await client('ACTIVE');
      await scan(token, payloadForSlot(tokens.computeSlot(EVENING, SLOT_SECONDS)));

      // Four hours later, same business date: past the 3-hour stale window.
      const later = new Date(EVENING.getTime() + 4 * 60 * 60_000);
      const fresh = await advanceTo(later);
      const body = await scan(fresh, payloadFor(later));

      expect(body.data?.outcome).toBe('RECHECKED_IN');
      expect(await ctx.prisma.checkIn.count({ where: { userId } })).toBe(2);
    });

    /**
     * §6.6.4. An accidental check-out was previously unrecoverable and cost a
     * phantom visit against the daily ceiling. `reopenCount` is recorded
     * rather than hidden, so a dispute can see that a visit was closed and
     * reopened.
     */
    it('reopens the same visit when a check-out is undone inside the window', async () => {
      const { token, userId } = await client('ACTIVE');
      await scan(token, payloadForSlot(tokens.computeSlot(EVENING, SLOT_SECONDS)));

      const out = new Date(EVENING.getTime() + 30 * 60_000);
      const outToken = await advanceTo(out);
      expect((await leave(outToken, out)).data?.outcome).toBe('CHECKED_OUT');

      const back = new Date(out.getTime() + 60_000);
      const backToken = await advanceTo(back);
      const body = await scan(backToken, payloadFor(back));

      expect(body.data?.outcome).toBe('REOPENED');
      expect(body.data?.display.tone).toBe('WELCOME');

      const rows = await ctx.prisma.checkIn.findMany({ where: { userId } });
      // ONE visit, not two — the whole point: no phantom row, no consumed
      // daily-limit slot.
      expect(rows).toHaveLength(1);
      expect(rows[0].reopenCount).toBe(1);
      expect(rows[0].endedAt).toBeNull();
      expect(rows[0].openUserId).toBe(userId);
      expect(rows[0].closeMethod).toBeNull();
      expect(rows[0].closeStationId).toBeNull();
      expect(rows[0].autoClosed).toBe(false);
    });

    /**
     * The labas-pasok case: scanned out, went home for the forgotten towel,
     * back in 45 minutes. Outside the 20-minute mistake-undo, inside
     * CHECKIN_REENTRY_GRACE_MINUTES (60) — same visit, no second slot burned
     * against the daily ceiling.
     */
    it('treats a return inside the re-entry grace as the same visit', async () => {
      const { token, userId } = await client('ACTIVE');
      await scan(token, payloadForSlot(tokens.computeSlot(EVENING, SLOT_SECONDS)));

      const out = new Date(EVENING.getTime() + 30 * 60_000);
      const outToken = await advanceTo(out);
      const goodbye = await leave(outToken, out);
      expect(goodbye.data?.outcome).toBe('CHECKED_OUT');
      // The card names the CONFIGURED window, not a baked-in 20.
      expect(goodbye.data?.display.detail).toContain('within 60 minutes');

      const back = new Date(out.getTime() + 45 * 60_000);
      const backToken = await advanceTo(back);
      const body = await scan(backToken, payloadFor(back));

      expect(body.data?.outcome).toBe('REOPENED');
      const rows = await ctx.prisma.checkIn.findMany({ where: { userId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].reopenCount).toBe(1);
      expect(rows[0].endedAt).toBeNull();
    });

    it('opens a legitimate second visit beyond the grace window', async () => {
      const { token, userId } = await client('ACTIVE');
      await scan(token, payloadForSlot(tokens.computeSlot(EVENING, SLOT_SECONDS)));

      const out = new Date(EVENING.getTime() + 30 * 60_000);
      const outToken = await advanceTo(out);
      expect((await leave(outToken, out)).data?.outcome).toBe('CHECKED_OUT');

      const back = new Date(out.getTime() + 61 * 60_000);
      const backToken = await advanceTo(back);
      const body = await scan(backToken, payloadFor(back));

      expect(body.data?.outcome).toBe('CHECKED_IN');
      const rows = await ctx.prisma.checkIn.findMany({
        where: { userId },
        orderBy: { occurredAt: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0].endedAt).not.toBeNull();
      expect(rows[1].openUserId).toBe(userId);
    });

    /**
     * A visit closed at 23:55 revisited at 00:05: the clock says "inside the
     * window", the civil date says "yesterday's visit". The date wins —
     * reopening would resurrect yesterday's businessDate on an open row, and
     * the NEXT scan would misread the visit as stale.
     */
    it('never reopens across a business date, even inside the time window', async () => {
      const { token, userId } = await client('ACTIVE');
      await scan(token, payloadForSlot(tokens.computeSlot(EVENING, SLOT_SECONDS)));

      const out = new Date(EVENING.getTime() + 30 * 60_000);
      const outToken = await advanceTo(out);
      expect((await leave(outToken, out)).data?.outcome).toBe('CHECKED_OUT');

      const yesterday = asCivilDate('2026-08-17');
      await ctx.prisma.checkIn.updateMany({
        where: { userId },
        data: { businessDate: toDateColumn(yesterday) },
      });

      const back = new Date(out.getTime() + 5 * 60_000);
      const backToken = await advanceTo(back);
      const body = await scan(backToken, payloadFor(back));

      expect(body.data?.outcome).toBe('CHECKED_IN');
      expect(await ctx.prisma.checkIn.count({ where: { userId } })).toBe(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Denials — 200 with a row
  // ───────────────────────────────────────────────────────────────────────

  describe('denials', () => {
    it('is a 200 with a denial row for an expired membership', async () => {
      const { token, userId } = await client('EXPIRED_PAST_GRACE');

      const body = await scan(token, payloadFor());

      expect(body.success).toBe(true);
      expect(body.data?.outcome).toBe('DENIED');
      // Never full-bleed, never red, never the word DENIED.
      expect(body.data?.display.tone).toBe('SEE_DESK');
      expect(body.data?.display.headline).toBe('Not checked in yet.');
      expect(body.data?.denial?.reason).toBe('MEMBERSHIP_EXPIRED');
      expect(body.data?.nextStep?.kind).toBe('RENEW_AT_DESK');
      expect(body.data?.checkIn).toBeNull();

      const denial = await ctx.prisma.checkInDenial.findFirstOrThrow({ where: { userId } });
      expect(denial.method).toBe('STATION_QR');
      expect(denial.stationId).toBe(station.id);
      expect(denial.outcome).toBe('UNRESOLVED');
      expect(denial.recordedById).toBeNull();
      expect(denial.membershipStatusAtTime).not.toBeNull();
    });

    /**
     * A SUSPENDED account never reaches this route at all: `AuthGuard` rejects
     * it before the controller, so `DenialReason.ACCOUNT_SUSPENDED` is
     * unreachable on the SELF path and is produced only on the staff paths,
     * where an operator is standing in front of the person.
     *
     * That is the right place for it, and it makes the dignity rule
     * structural rather than a copy decision: the member's phone gets a bare
     * non-2xx, the portal renders its single catch-all ("Check-in is
     * unavailable — please see the front desk"), and nothing about why the
     * account was closed is on a screen in a queue. The vague copy itself is
     * unit-tested in `check-in.presenter.spec.ts`, where the staff path can
     * reach it.
     */
    it('never lets a suspended account reach the door, and leaks no reason doing it', async () => {
      const { token, userId } = await client('ACTIVE');
      // The whole suspension trio, not `status` alone: User_suspend_shape and
      // its two siblings (20260827000000_member_suspend_fields) pair status
      // with suspendedAt, and suspendedAt with suspendedById/suspendReason. A
      // CHECK constrains every UPDATE whether or not it was added NOT VALID,
      // so a bare status write fails once that migration lands. suspendedById
      // is an FK (ON DELETE RESTRICT) and needs a real row — hence the admin
      // fixture rather than a fabricated uuid.
      await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
      const adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
      await ctx.prisma.user.update({
        where: { id: userId },
        data: {
          status: 'SUSPENDED',
          suspendedAt: new Date(),
          suspendedById: adminId,
          suspendReason: 'Suspended for the door-refusal check',
        },
      });

      const res = await request(server)
        .post('/api/v1/checkin')
        .set('Authorization', `Bearer ${token}`)
        .send({ stationToken: payloadFor() });

      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toMatch(/suspend/i);
      expect(await ctx.prisma.checkIn.count({ where: { userId } })).toBe(0);
      // Nothing is written, so a suspended account cannot be used to mint rows
      // on the desk feed either.
      expect(await ctx.prisma.stationScan.count({ where: { userId } })).toBe(0);
    });

    it('denies a member with no plan on file and offers the day pass', async () => {
      const { token } = await client('NO_MEMBERSHIP');

      const body = await scan(token, payloadFor());

      expect(body.data?.denial?.reason).toBe('NO_MEMBERSHIP');
      expect(body.data?.nextStep?.kind).toBe('WALK_IN_AT_DESK');
    });

    /**
     * The ceiling is a DENIAL WITH A ROW, not a silent throttle: it lands on
     * the desk feed, staff sees it, and an override is one PIN away. A limit
     * that fails silently teaches members the system is flaky.
     */
    it('denies a CLIENT past CHECKIN_MAX_VISITS_PER_DAY', async () => {
      const { token, userId } = await client('ACTIVE');
      const membership = await ctx.prisma.membership.findUniqueOrThrow({ where: { userId } });

      // Eight closed visits already today — the newest ending TWO hours ago,
      // safely outside the reopen window, so the ninth scan reaches the
      // ceiling instead of quietly resuming visit eight.
      for (let i = 0; i < 8; i += 1) {
        await ctx.prisma.checkIn.create({
          data: {
            userId,
            entryType: 'MEMBERSHIP',
            verdict: 'ALLOWED',
            membershipId: membership.id,
            membershipStatusAtTime: 'ACTIVE',
            occurredAt: new Date(EVENING.getTime() - (i + 3) * 60 * 60_000),
            businessDate: toDateColumn(asCivilDate(TODAY)),
            endedAt: new Date(EVENING.getTime() - (i + 2) * 60 * 60_000),
            closeMethod: 'STATION_QR',
            closeStationId: station.id,
            closeStationSlot: 1,
            method: 'STATION_QR',
            stationId: station.id,
            stationSlot: 1,
            idempotencyKey: `fixture-${i}`,
            idempotencyHash: '0'.repeat(64),
          },
        });
      }

      const body = await scan(token, payloadFor());

      expect(body.success).toBe(true);
      expect(body.data?.denial?.reason).toBe('CHECKIN_DAILY_LIMIT');
      expect(await ctx.prisma.checkInDenial.count({ where: { userId } })).toBe(1);
    });

    /**
     * The ceiling applies to CLIENT accounts ONLY. A coach training between
     * clients across a split shift is exactly the person a low ceiling denies,
     * and a limit whose only realistic victims are legitimate is not a
     * control.
     */
    it('does not apply the ceiling to staff who train', async () => {
      const token = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });
      const userId = await ctx.fixture.userIdFor(FIXTURE_IDS.COACH_A);
      await makeMember(ctx.prisma, { state: 'ACTIVE', today: asCivilDate(TODAY), userId });
      const membership = await ctx.prisma.membership.findUniqueOrThrow({ where: { userId } });

      for (let i = 0; i < 9; i += 1) {
        await ctx.prisma.checkIn.create({
          data: {
            userId,
            entryType: 'MEMBERSHIP',
            verdict: 'ALLOWED',
            membershipId: membership.id,
            membershipStatusAtTime: 'ACTIVE',
            occurredAt: new Date(EVENING.getTime() - (i + 3) * 60 * 60_000),
            businessDate: toDateColumn(asCivilDate(TODAY)),
            endedAt: new Date(EVENING.getTime() - (i + 2) * 60 * 60_000),
            closeMethod: 'STATION_QR',
            closeStationId: station.id,
            closeStationSlot: 1,
            method: 'STATION_QR',
            stationId: station.id,
            stationSlot: 1,
            idempotencyKey: `coach-fixture-${i}`,
            idempotencyHash: '0'.repeat(64),
          },
        });
      }

      const body = await scan(token, payloadFor());
      expect(body.data?.outcome).toBe('CHECKED_IN');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Token verification — the 4xx / 200 line
  // ───────────────────────────────────────────────────────────────────────

  describe('the station token', () => {
    it('400s a malformed payload before any database work', async () => {
      const { token } = await client('ACTIVE');
      const res = await request(server)
        .post('/api/v1/checkin')
        .set('Authorization', `Bearer ${token}`)
        .send({ stationToken: 'not-a-station-code' });

      expect(res.status).toBe(400);
      expect(await ctx.prisma.stationScan.count()).toBe(0);
    });

    /**
     * Unknown station, INACTIVE station, wrong epoch and a forged MAC are ONE
     * response on the wire. `isActive: false` is the "the tablet was stolen"
     * switch, and an endpoint that tells any member which stations are
     * deliberately disabled is reporting the incident to the person who caused
     * it.
     */
    it('collapses a forged MAC, an unknown station and an inactive one into one code', async () => {
      const { token } = await client('ACTIVE');
      const slot = tokens.computeSlot(EVENING, SLOT_SECONDS);

      const forged = tokens.buildPayload(station.code, slot, 'ZZZZZZZZZZZZZZZZ');
      const unknown = tokens.buildPayload('9Z9Z', slot, 'ZZZZZZZZZZZZZZZZ');

      const inactive = await seedStationForTest(ctx.prisma, { isActive: false, name: 'Back door' });
      const inactivePayload = payloadFor(EVENING, inactive);

      for (const payload of [forged, unknown, inactivePayload]) {
        const res = await request(server)
          .post('/api/v1/checkin')
          .set('Authorization', `Bearer ${token}`)
          .send({ stationToken: payload });

        expect(res.status).toBe(400);
        expect((res.body as Envelope<never>).error?.code).toBe('STATION_TOKEN_INVALID');
      }

      // A forged token WRITES NOTHING, so it cannot poison the desk feed, the
      // funnel or the relay-detection signals.
      expect(await ctx.prisma.stationScan.count()).toBe(0);
      expect(await ctx.prisma.checkInDenial.count()).toBe(0);
    });

    it('422s a future slot — a station-clock alarm, not a member action', async () => {
      const { token } = await client('ACTIVE');
      const future = tokens.computeSlot(EVENING, SLOT_SECONDS) + 10;

      const res = await request(server)
        .post('/api/v1/checkin')
        .set('Authorization', `Bearer ${token}`)
        .send({ stationToken: payloadForSlot(future) });

      expect(res.status).toBe(422);
      expect((res.body as Envelope<never>).error?.code).toBe('STATION_TOKEN_NOT_YET_VALID');
      expect(await ctx.prisma.checkInDenial.count()).toBe(0);
    });

    /**
     * A 200, changing the badge design's 410. The member scanned a real code
     * for the real station and was a few seconds late; that is a business
     * outcome the phone renders calmly, not an exception.
     */
    it('is a 200 denial with tokenStalenessSeconds for a stale slot', async () => {
      const { token, userId } = await client('ACTIVE');
      const stale = tokens.computeSlot(EVENING, SLOT_SECONDS) - 4;

      const res = await request(server)
        .post('/api/v1/checkin')
        .set('Authorization', `Bearer ${token}`)
        .send({ stationToken: payloadForSlot(stale) });

      expect(res.status).toBe(200);
      const body = res.body as Envelope<CheckInResult>;
      expect(body.data?.denial?.reason).toBe('STATION_TOKEN_EXPIRED');

      const denial = await ctx.prisma.checkInDenial.findFirstOrThrow({ where: { userId } });
      // The photograph-and-forward signature: a member 3 s late on a bad
      // connection and one 40 s late off a photo are indistinguishable as a
      // COUNT; as a DISTRIBUTION they are not.
      expect(denial.tokenStalenessSeconds).toBe(4 * SLOT_SECONDS);
    });

    it('accepts the previous slot, because latency runs forward only', async () => {
      const { token } = await client('ACTIVE');
      const previous = tokens.computeSlot(EVENING, SLOT_SECONDS) - 1;

      const body = await scan(token, payloadForSlot(previous));
      expect(body.data?.outcome).toBe('CHECKED_IN');
    });
  });

  /**
   * The gate is scoped to STATION_QR and lives in the service, never in
   * `accessVerdict()` — that function is a pure function of a CivilDate with
   * no time-of-day, and an hours check inside it would break both its purity
   * and its test contract.
   */
  describe('gym hours', () => {
    it('denies a self-scan out of hours, with a row and a 200', async () => {
      const { userId } = await client('ACTIVE');
      // 03:00 Manila the next day — outside 05:00-22:00 even with the
      // 15-minute buffer.
      const night = new Date('2026-08-18T19:00:00.000Z');
      const nightToken = await advanceTo(night);

      const body = await scan(nightToken, payloadFor(night));

      expect(body.success).toBe(true);
      expect(body.data?.denial?.reason).toBe('GYM_CLOSED');
      expect(await ctx.prisma.checkIn.count({ where: { userId } })).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // POST /checkin/checkout — the confirmed check-out (owner, 2026-10-20)
  // ───────────────────────────────────────────────────────────────────────

  describe('POST /api/v1/checkin/checkout', () => {
    /** Checked in at EVENING, second scan at +40 min; returns the offered card. */
    const insideAndRescanned = async (): Promise<{
      token: string;
      userId: string;
      checkInId: string;
      at: Date;
    }> => {
      const { token, userId } = await client('ACTIVE');
      await scan(token, payloadForSlot(tokens.computeSlot(EVENING, SLOT_SECONDS)));
      const at = new Date(EVENING.getTime() + 40 * 60_000);
      const fresh = await advanceTo(at);
      const offered = await scan(fresh, payloadFor(at));
      expect(offered.data?.outcome).toBe('ALREADY_INSIDE');
      return { token: fresh, userId, checkInId: offered.data!.checkIn!.id, at };
    };

    it('closes the visit as STATION_QR at the scanned station', async () => {
      const { token, userId, checkInId, at } = await insideAndRescanned();

      const { status, body } = await confirmOut(token, checkInId);

      expect(status).toBe(200);
      expect(body.data?.outcome).toBe('CHECKED_OUT');
      expect(body.data?.display.headline).toBe('Checked out.');
      expect(body.data?.session?.durationMinutes).toBe(40);

      const row = await ctx.prisma.checkIn.findUniqueOrThrow({ where: { id: checkInId } });
      expect(row.endedAt?.toISOString()).toBe(at.toISOString());
      expect(row.closeMethod).toBe('STATION_QR');
      expect(row.openUserId).toBeNull();
      expect(row.closeStationId).toBe(station.id);
      expect(row.closeStationSlot).toBe(tokens.computeSlot(at, SLOT_SECONDS));
      expect(row.closedById).toBeNull();
      expect(row.autoClosed).toBe(false);
      expect(await ctx.prisma.checkIn.count({ where: { userId } })).toBe(1);
    });

    it('answers a double tap with the same card and closes nothing twice', async () => {
      const { token, checkInId } = await insideAndRescanned();

      const first = await confirmOut(token, checkInId);
      const second = await confirmOut(token, checkInId);

      expect(second.status).toBe(200);
      expect(second.body.data?.outcome).toBe('CHECKED_OUT');
      expect(second.body.data?.session).toEqual(first.body.data?.session);
    });

    it('403s CHECK_OUT_SCAN_REQUIRED without a second scan', async () => {
      const { token, userId } = await client('ACTIVE');
      const opened = await scan(token, payloadFor());

      const { status, body } = await confirmOut(token, opened.data!.checkIn!.id);

      expect(status).toBe(403);
      expect(body.error?.code).toBe('CHECK_OUT_SCAN_REQUIRED');
      expect(body.error?.message).toBe('Scan the code at the desk again to check out.');
      const row = await ctx.prisma.checkIn.findUniqueOrThrow({ where: { openUserId: userId } });
      expect(row.endedAt).toBeNull();
    });

    it('403s when the second scan is older than two minutes', async () => {
      const { userId, checkInId, at } = await insideAndRescanned();
      // `consumedAt` is stamped by the DATABASE clock, not the suite's fake
      // one, so it is set explicitly to the instant under test.
      await ctx.prisma.stationScan.updateMany({
        where: { userId, outcome: 'ALREADY_INSIDE' },
        data: { consumedAt: at },
      });
      const late = new Date(at.getTime() + 2 * 60_000 + 1_000);
      const lateToken = await advanceTo(late);

      const { status, body } = await confirmOut(lateToken, checkInId);

      expect(status).toBe(403);
      expect(body.error?.code).toBe('CHECK_OUT_SCAN_REQUIRED');
    });

    /** A photo of an old code: recognised as a second scan, proves nothing. */
    it('offers no check-out off an EXPIRED code, and refuses it as proof', async () => {
      const { token } = await client('ACTIVE');
      await scan(token, payloadForSlot(tokens.computeSlot(EVENING, SLOT_SECONDS)));
      const at = new Date(EVENING.getTime() + 40 * 60_000);
      const fresh = await advanceTo(at);
      // Thirty minutes old: MAC-valid, long past the one-slot look-back.
      const old = tokens.computeSlot(new Date(at.getTime() - 30 * 60_000), SLOT_SECONDS);

      const offered = await scan(fresh, payloadForSlot(old));

      expect(offered.data?.outcome).toBe('ALREADY_INSIDE');
      expect(offered.data?.checkOutOffered).toBe(false);
      expect(offered.data?.display.detail).toBeNull();

      const { status, body } = await confirmOut(fresh, offered.data!.checkIn!.id);
      expect(status).toBe(403);
      expect(body.error?.code).toBe('CHECK_OUT_SCAN_REQUIRED');
    });

    it('refuses a scan from before a check-out and return', async () => {
      const { token, checkInId, at } = await insideAndRescanned();
      expect((await confirmOut(token, checkInId)).status).toBe(200);
      const back = new Date(at.getTime() + 40_000);
      const backToken = await advanceTo(back);
      expect((await scan(backToken, payloadFor(back))).data?.outcome).toBe('REOPENED');

      // The ALREADY_INSIDE scan at `at` is still inside two minutes, but it
      // belongs to the stretch before the reopen. (`consumedAt` is the
      // database clock, so both rows are pinned to the instants under test.)
      await ctx.prisma.stationScan.updateMany({
        where: { checkInId, outcome: 'ALREADY_INSIDE' },
        data: { consumedAt: at },
      });
      await ctx.prisma.stationScan.updateMany({
        where: { checkInId, outcome: 'REOPENED' },
        data: { consumedAt: back },
      });

      const { status, body } = await confirmOut(backToken, checkInId);
      expect(status).toBe(403);
      expect(body.error?.code).toBe('CHECK_OUT_SCAN_REQUIRED');
    });

    it('409s CHECK_OUT_NOT_OPEN for somebody else’s visit', async () => {
      const { checkInId } = await insideAndRescanned();
      const other = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_B });

      const { status, body } = await confirmOut(other, checkInId);

      expect(status).toBe(409);
      expect(body.error?.code).toBe('CHECK_OUT_NOT_OPEN');
      expect(body.error?.message).toBe("You're not checked in.");
      const row = await ctx.prisma.checkIn.findUniqueOrThrow({ where: { id: checkInId } });
      expect(row.endedAt).toBeNull();
    });

    it('400s a body that is not a visit id', async () => {
      const { token } = await client('ACTIVE');
      const res = await request(server)
        .post('/api/v1/checkin/checkout')
        .set('Authorization', `Bearer ${token}`)
        .send({ checkInId: 'nope' });
      expect(res.status).toBe(400);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // GET /me/check-in-status
  // ───────────────────────────────────────────────────────────────────────

  describe('GET /api/v1/me/check-in-status', () => {
    it('reports no open visit before the first scan', async () => {
      const { token } = await client('ACTIVE');

      const res = await request(server)
        .get('/api/v1/me/check-in-status')
        .set('Authorization', `Bearer ${token}`);

      const body = res.body as Envelope<CheckInStatus>;
      expect(res.status).toBe(200);
      expect(body.data?.open).toBeNull();
      expect(body.data?.wouldAdmit).toBe(true);
      expect(body.data?.visitsToday).toBe(0);
      expect(body.data?.membership.planName).toBe('Monthly');
    });

    /** The pre-flight line names the exact clock time the visit started. */
    it('reports the open visit', async () => {
      const { token } = await client('ACTIVE');
      await scan(token, payloadFor());

      const res = await request(server)
        .get('/api/v1/me/check-in-status')
        .set('Authorization', `Bearer ${token}`);

      const body = res.body as Envelope<CheckInStatus>;
      expect(body.data?.open?.startedAt).toBe(EVENING.toISOString());
      expect(body.data?.open).not.toHaveProperty('checkOutAvailableAt');
      expect(body.data?.visitsToday).toBe(1);
    });

    it('renders for a member with no plan rather than 404ing', async () => {
      const { token } = await client('NO_MEMBERSHIP');

      const res = await request(server)
        .get('/api/v1/me/check-in-status')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const body = res.body as Envelope<CheckInStatus>;
      expect(body.data?.wouldAdmit).toBe(false);
      expect(body.data?.membership.planName).toBeNull();
      expect(body.data?.membership.decision).toBe('DENY');
    });
  });
});
