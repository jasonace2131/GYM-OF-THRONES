import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Server } from 'http';
import type { CheckInRecord, CheckInResult } from '@got/shared';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { makeMember, openShift, seedPlansForTest } from './support/membership-fixtures';
import { seedStationForTest } from './support/station-fixtures';
import { asCivilDate, gymToday, toDateColumn } from '../src/common/time/gym-time';

jest.setTimeout(180_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** 18:00 Manila — inside gym hours, so the hours gate is never the reason. */
const EVENING = new Date('2026-08-18T10:00:00.000Z');
const TODAY = asCivilDate(gymToday(EVENING, 'Asia/Manila'));

describe('the desk records a check-in (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let deskToken: string;
  let deskId: string;
  let adminToken: string;

  const post = (token: string, path: string, body: Record<string, unknown>): request.Test =>
    request(server)
      .post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body);

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await seedPlansForTest(ctx.prisma);
    deskToken = await ctx.fixture.tokenFor('FRONT_DESK', { supabaseId: FIXTURE_IDS.FRONT_DESK });
    deskId = await ctx.fixture.userIdFor(FIXTURE_IDS.FRONT_DESK);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(EVENING);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** A member with a photo, so `identityConfirmed` is not in play. */
  const member = async (
    state: Parameters<typeof makeMember>[1]['state'] = 'ACTIVE',
  ): Promise<{ userId: string; memberCode: string | null }> => {
    const fixture = await makeMember(ctx.prisma, { state, today: TODAY });
    await ctx.prisma.user.update({
      where: { id: fixture.userId },
      data: { avatarUrl: 'https://cdn.example/photo.jpg' },
    });
    return { userId: fixture.userId, memberCode: fixture.memberCode };
  };

  const withShift = async (): Promise<string> => openShift(ctx.prisma, deskId, TODAY);

  // ───────────────────────────────────────────────────────────────────────
  // Route 45 — the path that carries a quarter of arrivals
  // ───────────────────────────────────────────────────────────────────────

  describe('POST /front-desk/check-ins', () => {
    it('admits a member found by name, attributed to the operator', async () => {
      const shiftId = await withShift();
      const m = await member();

      const res = await post(deskToken, '/front-desk/check-ins', { userId: m.userId });
      const body = res.body as Envelope<CheckInResult>;

      expect(res.status).toBe(201);
      expect(body.data?.outcome).toBe('CHECKED_IN');
      expect(body.data?.display.tone).toBe('WELCOME');
      // No station on this path, by construction.
      expect(body.data?.station).toBeNull();

      const row = await ctx.prisma.checkIn.findUniqueOrThrow({ where: { openUserId: m.userId } });
      expect(row.method).toBe('MANUAL');
      // A staff action is ALWAYS reconcilable to a named person and a counted
      // drawer — both enforced by CHECK constraints, not by this assertion.
      expect(row.recordedById).toBe(deskId);
      expect(row.shiftId).toBe(shiftId);
      expect(row.stationId).toBeNull();
      expect(row.stationSlot).toBeNull();
    });

    /**
     * A TYPED CODE and a NAME SEARCH are different identity claims, and the
     * data tells them apart so a later fraud review can distinguish "they had
     * their card" from "a staffer recognised them".
     */
    it('records a typed member code as MEMBER_CODE, not MANUAL', async () => {
      await withShift();
      const m = await member();

      const res = await post(deskToken, '/front-desk/check-ins', { memberCode: m.memberCode });
      expect(res.status).toBe(201);

      const row = await ctx.prisma.checkIn.findUniqueOrThrow({ where: { openUserId: m.userId } });
      expect(row.method).toBe('MEMBER_CODE');
    });

    it('rejects naming a member two ways at once', async () => {
      await withShift();
      const m = await member();

      const res = await post(deskToken, '/front-desk/check-ins', {
        userId: m.userId,
        memberCode: m.memberCode,
      });
      expect(res.status).toBe(400);
    });

    it('rejects naming a member no way at all', async () => {
      await withShift();
      const res = await post(deskToken, '/front-desk/check-ins', {});
      expect(res.status).toBe(400);
    });

    /**
     * Money or a staff action must always be reconcilable to a counted drawer.
     * Unlike the member's own scan — which must never be blocked on staff
     * having opened the till — this path hard-fails.
     */
    it('refuses to record anything with no drawer open', async () => {
      const m = await member();

      const res = await post(deskToken, '/front-desk/check-ins', { userId: m.userId });
      expect(res.status).toBe(422);
      expect((res.body as Envelope<never>).error?.code).toBe('SHIFT_NOT_OPEN');
      expect(await ctx.prisma.checkIn.count()).toBe(0);
    });

    /**
     * THE GYM-HOURS GATE NEVER APPLIES HERE. An early opening, a public
     * holiday or a `GYM_TIMEZONE` typo must not leave staff standing at the
     * desk with a member in front of them, unable to record anything.
     */
    it('works outside gym hours, where a self-scan would be denied', async () => {
      // 03:00 Manila — the self-scan path answers GYM_CLOSED here.
      const night = new Date('2026-08-18T19:00:00.000Z');
      jest.setSystemTime(night);
      const nightToday = asCivilDate(gymToday(night, 'Asia/Manila'));

      const fresh = await ctx.fixture.tokenFor('FRONT_DESK', {
        supabaseId: FIXTURE_IDS.FRONT_DESK,
      });
      await openShift(ctx.prisma, deskId, nightToday);
      const fixture = await makeMember(ctx.prisma, { state: 'ACTIVE', today: nightToday });
      await ctx.prisma.user.update({
        where: { id: fixture.userId },
        data: { avatarUrl: 'https://cdn.example/photo.jpg' },
      });

      const res = await post(fresh, '/front-desk/check-ins', { userId: fixture.userId });
      expect(res.status).toBe(201);
      expect((res.body as Envelope<CheckInResult>).data?.outcome).toBe('CHECKED_IN');
    });

    /**
     * The photo is the desk's identity control on this path. With none, the
     * operator asserts recognition EXPLICITLY rather than it being inferred
     * from a missing column.
     */
    it('requires an explicit identity confirmation when there is no photo', async () => {
      await withShift();
      const fixture = await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });

      const refused = await post(deskToken, '/front-desk/check-ins', { userId: fixture.userId });
      expect(refused.status).toBe(400);
      expect((refused.body as Envelope<never>).error?.code).toBe('CONFIRMATION_REQUIRED');

      const allowed = await post(deskToken, '/front-desk/check-ins', {
        userId: fixture.userId,
        identityConfirmed: true,
      });
      expect(allowed.status).toBe(201);
    });

    /** The SAME door ladder the member's own scan runs. */
    it('denies an expired member and writes the denial to the desk feed', async () => {
      await withShift();
      const m = await member('EXPIRED_PAST_GRACE');

      const res = await post(deskToken, '/front-desk/check-ins', { userId: m.userId });
      const body = res.body as Envelope<CheckInResult>;

      expect(res.status).toBe(201);
      expect(body.data?.outcome).toBe('DENIED');
      expect(body.data?.denial?.reason).toBe('MEMBERSHIP_EXPIRED');

      const denial = await ctx.prisma.checkInDenial.findFirstOrThrow();
      expect(denial.method).toBe('MANUAL');
      // Biconditional: a non-STATION_QR denial names its recorder and its till.
      expect(denial.recordedById).toBe(deskId);
      expect(denial.shiftId).not.toBeNull();
    });

    it('answers ALREADY_INSIDE rather than opening a second visit', async () => {
      await withShift();
      const m = await member();

      await post(deskToken, '/front-desk/check-ins', { userId: m.userId }).expect(201);
      const second = await post(deskToken, '/front-desk/check-ins', { userId: m.userId });

      expect((second.body as Envelope<CheckInResult>).data?.outcome).toBe('ALREADY_INSIDE');
      expect(await ctx.prisma.checkIn.count({ where: { userId: m.userId } })).toBe(1);
    });

    it('404s an unknown member, the same way for a bad id and a bad code', async () => {
      await withShift();

      const byId = await post(deskToken, '/front-desk/check-ins', {
        userId: '00000000-0000-4000-8000-000000000000',
      });
      const byCode = await post(deskToken, '/front-desk/check-ins', { memberCode: 'ZZZZZZ' });

      expect(byId.status).toBe(404);
      expect(byCode.status).toBe(404);
      expect((byId.body as Envelope<never>).error?.code).toBe(
        (byCode.body as Envelope<never>).error?.code,
      );
    });

    it('refuses a member', async () => {
      const token = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
      const res = await post(token, '/front-desk/check-ins', {
        userId: '00000000-0000-4000-8000-000000000000',
      });
      expect(res.status).toBe(403);
    });

    describe('the desk’s own offline queue', () => {
      /**
       * A staff-attributed write is exactly the kind a queue CAN safely carry:
       * the accountable party is a named operator, not a client-set boolean.
       * The member has no such queue and never will.
       */
      it('accepts a backdated entry and dates it to when it happened', async () => {
        await withShift();
        const m = await member();
        const earlier = new Date(EVENING.getTime() - 2 * 3_600_000);

        const res = await post(deskToken, '/front-desk/check-ins', {
          userId: m.userId,
          occurredAt: earlier.toISOString(),
          offlineQueued: true,
        });
        expect(res.status).toBe(201);

        const row = await ctx.prisma.checkIn.findUniqueOrThrow({
          where: { openUserId: m.userId },
        });
        expect(row.occurredAt.toISOString()).toBe(earlier.toISOString());
        expect(row.offlineQueued).toBe(true);
      });

      /**
       * REJECTED, not silently clamped. A queue flushing a two-day-old entry
       * is a bug in the console, and quietly rewriting its timestamp would
       * hide that while putting a visit on the wrong business date.
       */
      it('refuses an entry older than the queue’s own bound', async () => {
        await withShift();
        const m = await member();
        const ancient = new Date(EVENING.getTime() - 48 * 3_600_000);

        const res = await post(deskToken, '/front-desk/check-ins', {
          userId: m.userId,
          occurredAt: ancient.toISOString(),
        });
        expect(res.status).toBe(422);
        expect((res.body as Envelope<never>).error?.code).toBe('CHECKIN_OCCURRED_AT_OUT_OF_RANGE');
      });

      it('refuses an entry from the future', async () => {
        await withShift();
        const m = await member();

        const res = await post(deskToken, '/front-desk/check-ins', {
          userId: m.userId,
          occurredAt: new Date(EVENING.getTime() + 3_600_000).toISOString(),
        });
        expect(res.status).toBe(422);
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Routes 46 and 47
  // ───────────────────────────────────────────────────────────────────────

  describe('POST /front-desk/check-ins/:id/checkout', () => {
    it('closes an open visit, attributed to the operator', async () => {
      await withShift();
      const m = await member();
      const opened = await post(deskToken, '/front-desk/check-ins', { userId: m.userId });
      const checkInId = (opened.body as Envelope<CheckInResult>).data?.checkIn?.id as string;

      jest.setSystemTime(new Date(EVENING.getTime() + 45 * 60_000));
      const fresh = await ctx.fixture.tokenFor('FRONT_DESK', {
        supabaseId: FIXTURE_IDS.FRONT_DESK,
      });

      const res = await request(server)
        .post(`/api/v1/front-desk/check-ins/${checkInId}/checkout`)
        .set('Authorization', `Bearer ${fresh}`)
        .send({});

      const body = res.body as Envelope<CheckInRecord>;
      expect(res.status).toBe(200);
      expect(body.data?.durationMinutes).toBe(45);
      expect(body.data?.closeMethod).toBe('MANUAL');
      // Excluded from duration statistics only for AUTO_CLOSE / STALE_CLOSE.
      expect(body.data?.autoClosed).toBe(false);

      const row = await ctx.prisma.checkIn.findUniqueOrThrow({ where: { id: checkInId } });
      expect(row.closedById).toBe(deskId);
      // The sentinel clears in the same statement that stamps endedAt.
      expect(row.openUserId).toBeNull();
    });

    /** Two operators tapping at once produce exactly one winner. */
    it('422s a second close rather than stamping over the first', async () => {
      await withShift();
      const m = await member();
      const opened = await post(deskToken, '/front-desk/check-ins', { userId: m.userId });
      const checkInId = (opened.body as Envelope<CheckInResult>).data?.checkIn?.id as string;

      const url = `/api/v1/front-desk/check-ins/${checkInId}/checkout`;
      await request(server)
        .post(url)
        .set('Authorization', `Bearer ${deskToken}`)
        .send({})
        .expect(200);
      const second = await request(server)
        .post(url)
        .set('Authorization', `Bearer ${deskToken}`)
        .send({});

      expect(second.status).toBe(422);
      expect((second.body as Envelope<never>).error?.code).toBe('CHECKIN_ALREADY_CLOSED');
    });

    it('404s a visit that does not exist', async () => {
      const res = await request(server)
        .post('/api/v1/front-desk/check-ins/00000000-0000-4000-8000-000000000000/checkout')
        .set('Authorization', `Bearer ${deskToken}`)
        .send({});
      expect(res.status).toBe(404);
    });
  });

  describe('POST /front-desk/check-ins/:id/void', () => {
    const voidUrl = (id: string): string => `/api/v1/front-desk/check-ins/${id}/void`;

    it('is ADMIN only — front desk cannot void', async () => {
      await withShift();
      const m = await member();
      const opened = await post(deskToken, '/front-desk/check-ins', { userId: m.userId });
      const checkInId = (opened.body as Envelope<CheckInResult>).data?.checkIn?.id as string;

      const res = await request(server)
        .post(voidUrl(checkInId))
        .set('Authorization', `Bearer ${deskToken}`)
        .send({ confirm: true, reason: 'wrong member' });
      expect(res.status).toBe(403);
    });

    it('requires an explicit confirmation', async () => {
      await withShift();
      const m = await member();
      const opened = await post(deskToken, '/front-desk/check-ins', { userId: m.userId });
      const checkInId = (opened.body as Envelope<CheckInResult>).data?.checkIn?.id as string;

      const res = await request(server)
        .post(voidUrl(checkInId))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirm: false, reason: 'wrong member' });

      expect(res.status).toBe(400);
      expect((res.body as Envelope<never>).error?.code).toBe('CONFIRMATION_REQUIRED');
    });

    /**
     * A VOID IS A CORRECTION, NEVER A DELETE. The row stays — deleting it
     * would remove the evidence that a mistake was made, which is the one
     * thing an audit trail exists for.
     */
    it('keeps the row, records who and why, and frees the member to check in again', async () => {
      await withShift();
      const m = await member();
      const opened = await post(deskToken, '/front-desk/check-ins', { userId: m.userId });
      const checkInId = (opened.body as Envelope<CheckInResult>).data?.checkIn?.id as string;

      const res = await request(server)
        .post(voidUrl(checkInId))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirm: true, reason: 'recorded against the wrong member' });

      expect(res.status).toBe(200);
      expect((res.body as Envelope<CheckInRecord>).data?.voidReason).toBe(
        'recorded against the wrong member',
      );

      const row = await ctx.prisma.checkIn.findUniqueOrThrow({ where: { id: checkInId } });
      expect(row.voidedAt).not.toBeNull();
      expect(row.voidedById).not.toBeNull();
      // THE SENTINEL IS RELEASED. Otherwise the member could never check in
      // again: the unique index still counts a row nobody can see.
      expect(row.openUserId).toBeNull();

      const again = await post(deskToken, '/front-desk/check-ins', { userId: m.userId });
      expect((again.body as Envelope<CheckInResult>).data?.outcome).toBe('CHECKED_IN');
    });

    it('422s a second void', async () => {
      await withShift();
      const m = await member();
      const opened = await post(deskToken, '/front-desk/check-ins', { userId: m.userId });
      const checkInId = (opened.body as Envelope<CheckInResult>).data?.checkIn?.id as string;

      const body = { confirm: true, reason: 'duplicate entry' };
      await request(server)
        .post(voidUrl(checkInId))
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body)
        .expect(200);

      const second = await request(server)
        .post(voidUrl(checkInId))
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body);
      expect(second.status).toBe(422);
      expect((second.body as Envelope<never>).error?.code).toBe('CHECKIN_ALREADY_VOIDED');
    });

    /** A voided visit is invisible to every count that matters. */
    it('drops the visit off the live board and the day’s total', async () => {
      await withShift();
      const m = await member();
      const opened = await post(deskToken, '/front-desk/check-ins', { userId: m.userId });
      const checkInId = (opened.body as Envelope<CheckInResult>).data?.checkIn?.id as string;

      await request(server)
        .post(voidUrl(checkInId))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ confirm: true, reason: 'test' })
        .expect(200);

      const today = await request(server)
        .get('/api/v1/front-desk/today')
        .set('Authorization', `Bearer ${deskToken}`);
      const counters = (today.body as Envelope<{ counters: { inGym: number; today: number } }>).data
        ?.counters;

      expect(counters?.inGym).toBe(0);
      expect(counters?.today).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Route 48 — overriding a denial
  // ───────────────────────────────────────────────────────────────────────

  describe('POST /front-desk/denials/:id/override', () => {
    /** Eight QR visits already closed today, well outside the reopen window. */
    const atCeiling = async (userId: string): Promise<void> => {
      const station = await seedStationForTest(ctx.prisma);
      const membership = await ctx.prisma.membership.findUniqueOrThrow({ where: { userId } });
      for (let i = 0; i < 8; i += 1) {
        await ctx.prisma.checkIn.create({
          data: {
            userId,
            entryType: 'MEMBERSHIP',
            verdict: 'ALLOWED',
            membershipId: membership.id,
            membershipStatusAtTime: 'ACTIVE',
            occurredAt: new Date(EVENING.getTime() - (i + 3) * 60 * 60_000),
            businessDate: toDateColumn(TODAY),
            endedAt: new Date(EVENING.getTime() - (i + 2) * 60 * 60_000),
            closeMethod: 'STATION_QR',
            closeStationId: station.id,
            closeStationSlot: i + 1,
            method: 'STATION_QR',
            stationId: station.id,
            stationSlot: i + 1,
            idempotencyKey: `ceiling-${i}`,
            idempotencyHash: '0'.repeat(64),
          },
        });
      }
    };

    /**
     * THE GATE THE OVERRIDE EXISTS FOR. Before `overriding` was threaded
     * through, this admission re-ran the same daily ceiling, produced a
     * SECOND identical denial, and still marked the first one resolved — the
     * desk said "Override with a PIN" and the PIN did nothing.
     */
    it('admits past the daily ceiling and closes the loop on the denial', async () => {
      await withShift();
      const m = await member();
      await atCeiling(m.userId);

      const denied = await post(deskToken, '/front-desk/check-ins', { userId: m.userId });
      const deniedBody = denied.body as Envelope<CheckInResult>;
      expect(deniedBody.data?.outcome).toBe('DENIED');
      expect(deniedBody.data?.denial?.reason).toBe('CHECKIN_DAILY_LIMIT');
      const denialId = deniedBody.data?.denial?.id as string;

      const res = await post(adminToken, `/front-desk/denials/${denialId}/override`, {
        reason: 'Coach cleared a second evening session',
        confirm: true,
      });
      const body = res.body as Envelope<CheckInResult>;

      expect(body.data?.outcome).toBe('CHECKED_IN');
      expect(body.data?.denial).toBeNull();

      const denialRow = await ctx.prisma.checkInDenial.findUniqueOrThrow({
        where: { id: denialId },
      });
      expect(denialRow.outcome).toBe('OVERRIDDEN');
      expect(denialRow.resolvedByCheckInId).toBe(body.data?.checkIn?.id);
      // The override relaxed ONE gate; the ninth visit is a real row.
      expect(
        await ctx.prisma.checkIn.count({ where: { userId: m.userId, voidedAt: null } }),
      ).toBe(9);
    });

    /**
     * The override relaxes EXACTLY the gate that denied — an expired member
     * is still expired, and the desk's path for them is the ₱90 walk-in on
     * the rail, not a free admission.
     */
    it('does not admit an expired membership past the door ladder', async () => {
      await withShift();
      const m = await member('EXPIRED_PAST_GRACE');

      const denied = await post(deskToken, '/front-desk/check-ins', { userId: m.userId });
      const denialId = (denied.body as Envelope<CheckInResult>).data?.denial?.id as string;

      const res = await post(adminToken, `/front-desk/denials/${denialId}/override`, {
        reason: 'Trying to wave through an expired member',
        confirm: true,
      });
      const body = res.body as Envelope<CheckInResult>;

      expect(body.data?.outcome).toBe('DENIED');
      expect(await ctx.prisma.checkIn.count({ where: { userId: m.userId } })).toBe(0);
    });
  });
});
