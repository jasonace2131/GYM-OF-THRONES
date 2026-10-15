import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Server } from 'http';
import type { CheckInRecord } from '@got/shared';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { makeMember, openShift, seedPlansForTest } from './support/membership-fixtures';
import { asCivilDate, gymToday } from '../src/common/time/gym-time';

jest.setTimeout(180_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const NOON = new Date('2026-08-18T04:00:00.000Z');
const TODAY = asCivilDate(gymToday(NOON, 'Asia/Manila'));
/** `WALKIN` is ₱90 in the seeded catalogue. */
const WALK_IN_PRICE = 9000;

describe('the desk sells a walk-in (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let deskToken: string;
  let deskId: string;

  const sell = (body: Record<string, unknown>, token = deskToken): request.Test =>
    request(server)
      .post('/api/v1/front-desk/walk-ins')
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
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(NOON);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const withShift = (): Promise<string> => openShift(ctx.prisma, deskId, TODAY);

  // ───────────────────────────────────────────────────────────────────────

  describe('authorisation', () => {
    it('refuses a member and a coach', async () => {
      for (const role of ['CLIENT', 'COACH'] as const) {
        const token = await ctx.fixture.tokenFor(role, {
          supabaseId: role === 'CLIENT' ? FIXTURE_IDS.CLIENT_A : FIXTURE_IDS.COACH_A,
        });
        const res = await sell({ kind: 'WALK_IN' }, token);
        expect(res.status).toBe(403);
      }
    });
  });

  describe('WALK_IN', () => {
    /**
     * Money without a counted drawer is the one thing that cannot be
     * reconciled later, so this hard-fails rather than booking the sale
     * against nothing.
     */
    it('refuses to take money with no drawer open', async () => {
      const res = await sell({ kind: 'WALK_IN', guestName: 'Nino Cruz' });
      expect(res.status).toBe(422);
      expect((res.body as Envelope<never>).error?.code).toBe('SHIFT_NOT_OPEN');
      expect(await ctx.prisma.payment.count()).toBe(0);
      expect(await ctx.prisma.checkIn.count()).toBe(0);
    });

    it('writes a payment and an entry for someone off the street', async () => {
      const shiftId = await withShift();

      const res = await sell({
        kind: 'WALK_IN',
        guestName: 'Nino Cruz',
        guestEmail: 'guest@example.com',
        guestPhone: '0917 555 0101',
        guestWaiverAccepted: true,
        method: 'CASH',
      });

      expect(res.status).toBe(201);
      const record = (res.body as Envelope<CheckInRecord>).data as CheckInRecord;
      expect(record.entryType).toBe('WALK_IN');
      // No account, so no user id — the board still shows a name.
      expect(record.member.userId).toBeNull();
      expect(record.member.firstName).toBe('Nino');

      const payment = await ctx.prisma.payment.findFirstOrThrow();
      expect(payment.purpose).toBe('WALK_IN');
      expect(payment.netCentavos).toBe(WALK_IN_PRICE);
      // NOT NULL throughout: money is always reconcilable to a counted drawer.
      expect(payment.shiftId).toBe(shiftId);
      expect(payment.recordedById).toBe(deskId);

      const entry = await ctx.prisma.checkIn.findFirstOrThrow();
      expect(entry.paymentId).toBe(payment.id);
      expect(entry.membershipId).toBeNull();
      // The sentinel is per-USER, and somebody with no account cannot hold one.
      expect(entry.openUserId).toBeNull();
    });

    /**
     * The console echoes back what it showed the member. A mismatch means the
     * price list moved under a sheet that was already open — ringing a
     * different number than the one quoted is worse than refusing.
     */
    it('refuses a sale whose quoted price no longer matches', async () => {
      await withShift();

      const res = await sell({
        kind: 'WALK_IN',
        guestName: 'Nino Cruz',
        guestEmail: 'guest@example.com',
        guestWaiverAccepted: true,
        method: 'CASH',
        netCentavos: WALK_IN_PRICE - 1000,
      });

      expect(res.status).toBe(422);
      expect((res.body as Envelope<never>).error?.code).toBe('PAYMENT_AMOUNT_MISMATCH');
      expect(await ctx.prisma.payment.count()).toBe(0);
    });

    /**
     * RA 9994 / RA 10754 name workout gyms: 20% plus VAT exemption is
     * MANDATORY and refusing it is a criminal offence. The desk rings it
     * without finding a manager.
     */
    it('lets the desk ring a statutory discount itself', async () => {
      await withShift();

      const res = await sell({
        kind: 'WALK_IN',
        guestName: 'Lola Reyes',
        guestEmail: 'guest@example.com',
        guestWaiverAccepted: true,
        method: 'CASH',
        discountType: 'SENIOR',
        statutoryIdNo: 'OSCA-12345',
      });

      expect(res.status).toBe(201);
      const payment = await ctx.prisma.payment.findFirstOrThrow();
      expect(payment.discountType).toBe('SENIOR');
      expect(payment.discountCentavos).toBeGreaterThan(0);
      expect(payment.netCentavos).toBeLessThan(WALK_IN_PRICE);
    });

    it('records a GCash reference, and refuses GCash without one', async () => {
      await withShift();

      const missing = await sell({
        kind: 'WALK_IN',
        guestName: 'Nino',
        guestEmail: 'guest@example.com',
        guestWaiverAccepted: true,
        method: 'GCASH',
      });
      expect(missing.status).toBe(422);
      expect((missing.body as Envelope<never>).error?.code).toBe('GCASH_REFERENCE_REQUIRED');

      const ok = await sell({
        kind: 'WALK_IN',
        guestName: 'Nino',
        guestEmail: 'guest@example.com',
        guestWaiverAccepted: true,
        method: 'GCASH',
        reference: '1234-5678-9012',
      });
      expect(ok.status).toBe(201);
    });

    /**
     * THE ENTITLEMENT IS THE CheckIn ROW — there is no DayPass model. A member
     * whose plan cannot admit them buys a day and the DOOR then lets them in,
     * which is the only proof that the two halves agree.
     */
    it('admits an expired member at the door for the rest of the day', async () => {
      await withShift();
      const member = await makeMember(ctx.prisma, {
        state: 'EXPIRED_PAST_GRACE',
        today: TODAY,
      });
      await ctx.prisma.user.update({
        where: { id: member.userId },
        data: { avatarUrl: 'https://cdn.example/p.jpg' },
      });

      await sell({ kind: 'WALK_IN', userId: member.userId, method: 'CASH' }).expect(201);

      // Close the walk-in visit so the next entry is a fresh decision.
      await ctx.prisma.checkIn.updateMany({
        where: { userId: member.userId },
        data: { endedAt: NOON, closeMethod: 'MANUAL', closedById: deskId, openUserId: null },
      });

      const again = await request(server)
        .post('/api/v1/front-desk/check-ins')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ userId: member.userId });

      // Admitted on the day pass, and REOPENING the paid visit rather than
      // opening a second one — one paid day is one visit.
      expect(again.status).toBe(201);
      expect((again.body as Envelope<{ outcome: string }>).data?.outcome).toBe('REOPENED');
      expect(await ctx.prisma.checkIn.count({ where: { userId: member.userId } })).toBe(1);
    });
  });

  describe('GUEST_PASS', () => {
    /**
     * ANNUAL, because `Membership_counters_sane` requires
     * `guestPassesRemaining BETWEEN 0 AND guestPassesPerTerm` — and MONTHLY
     * grants none. The allowance is a property of the PLAN, not a number a
     * fixture may invent, and the constraint refusing that is the constraint
     * working.
     */
    const hostWithPasses = async (passes: number): Promise<string> => {
      const host = await makeMember(ctx.prisma, {
        state: 'ACTIVE',
        today: TODAY,
        planCode: 'ANNUAL',
      });
      const membership = await ctx.prisma.membership.update({
        where: { userId: host.userId },
        data: { guestPassesRemaining: passes },
      });
      return membership.id;
    };

    /** No Payment at all — which is why Payment_amount_positive never bends. */
    it('spends a host’s pass and writes no payment', async () => {
      await withShift();
      const hostMembershipId = await hostWithPasses(2);

      const res = await sell({
        kind: 'GUEST_PASS',
        hostMembershipId,
        guestName: 'Ana Guest',
        guestEmail: 'guest@example.com',
        guestWaiverAccepted: true,
      });

      expect(res.status).toBe(201);
      expect((res.body as Envelope<CheckInRecord>).data?.entryType).toBe('GUEST_PASS');
      expect(await ctx.prisma.payment.count()).toBe(0);

      const membership = await ctx.prisma.membership.findUniqueOrThrow({
        where: { id: hostMembershipId },
      });
      expect(membership.guestPassesRemaining).toBe(1);

      const entry = await ctx.prisma.checkIn.findFirstOrThrow();
      expect(entry.paymentId).toBeNull();
      // The HOST's term, whose allowance was just spent.
      expect(entry.membershipId).toBe(hostMembershipId);
    });

    it('refuses when the host has none left', async () => {
      await withShift();
      const hostMembershipId = await hostWithPasses(0);

      const res = await sell({
        kind: 'GUEST_PASS',
        hostMembershipId,
        guestName: 'Ana',
        guestEmail: 'guest@example.com',
        guestWaiverAccepted: true,
      });
      expect(res.status).toBe(422);
      expect((res.body as Envelope<never>).error?.code).toBe('GUEST_PASS_EXHAUSTED');
      expect(await ctx.prisma.checkIn.count()).toBe(0);
    });

    it('requires a host', async () => {
      await withShift();
      const res = await sell({ kind: 'GUEST_PASS', guestName: 'Ana', guestWaiverAccepted: true });
      expect(res.status).toBe(422);
    });

    /**
     * A CONDITIONAL decrement, not read-then-write. Two staff spending the
     * last pass at once would otherwise both read `1` and both succeed.
     */
    it('never lets the last pass be spent twice', async () => {
      await withShift();
      const hostMembershipId = await hostWithPasses(1);

      const first = await sell({
        kind: 'GUEST_PASS',
        hostMembershipId,
        guestName: 'Guest One',
        guestEmail: 'guest@example.com',
        guestWaiverAccepted: true,
      });
      const second = await sell({
        kind: 'GUEST_PASS',
        hostMembershipId,
        guestName: 'Guest Two',
        guestEmail: 'guest@example.com',
        guestWaiverAccepted: true,
      });

      expect(first.status).toBe(201);
      expect(second.status).toBe(422);

      const membership = await ctx.prisma.membership.findUniqueOrThrow({
        where: { id: hostMembershipId },
      });
      expect(membership.guestPassesRemaining).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // The funnel — a denial is the highest-intent sales moment the gym gets
  // ───────────────────────────────────────────────────────────────────────

  describe('resolving a denial', () => {
    const denyAtTheDesk = async (): Promise<{ denialId: string; userId: string }> => {
      const member = await makeMember(ctx.prisma, {
        state: 'EXPIRED_PAST_GRACE',
        today: TODAY,
      });
      await ctx.prisma.user.update({
        where: { id: member.userId },
        data: { avatarUrl: 'https://cdn.example/p.jpg' },
      });

      await request(server)
        .post('/api/v1/front-desk/check-ins')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ userId: member.userId })
        .expect(201);

      const denial = await ctx.prisma.checkInDenial.findFirstOrThrow();
      return { denialId: denial.id, userId: member.userId };
    };

    it('marks the denial resolved and points it at the sale', async () => {
      await withShift();
      const { denialId, userId } = await denyAtTheDesk();

      const res = await sell({ kind: 'WALK_IN', userId, method: 'CASH', denialId });
      expect(res.status).toBe(201);
      const checkInId = (res.body as Envelope<CheckInRecord>).data?.checkInId;

      const denial = await ctx.prisma.checkInDenial.findUniqueOrThrow({ where: { id: denialId } });
      expect(denial.outcome).toBe('RESOLVED_WALK_IN');
      expect(denial.resolvedByCheckInId).toBe(checkInId);
      expect(denial.resolvedAt).not.toBeNull();
    });

    it('drops the resolved denial off the desk’s needs-you count', async () => {
      await withShift();
      const { denialId, userId } = await denyAtTheDesk();

      const before = await request(server)
        .get('/api/v1/front-desk/today')
        .set('Authorization', `Bearer ${deskToken}`);
      expect(
        (before.body as Envelope<{ counters: { needsYou: number } }>).data?.counters.needsYou,
      ).toBe(1);

      await sell({ kind: 'WALK_IN', userId, method: 'CASH', denialId }).expect(201);

      const after = await request(server)
        .get('/api/v1/front-desk/today')
        .set('Authorization', `Bearer ${deskToken}`);
      expect(
        (after.body as Envelope<{ counters: { needsYou: number } }>).data?.counters.needsYou,
      ).toBe(0);
    });

    /**
     * A denial a manager already overrode is a DIFFERENT commercial outcome
     * from a sale, and the report distinguishes them — so it is never
     * silently re-labelled.
     */
    it('refuses to re-resolve a denial that was already dealt with', async () => {
      await withShift();
      const { denialId, userId } = await denyAtTheDesk();

      await sell({ kind: 'WALK_IN', userId, method: 'CASH', denialId }).expect(201);
      await ctx.prisma.checkIn.updateMany({
        where: { userId },
        data: { endedAt: NOON, closeMethod: 'MANUAL', closedById: deskId, openUserId: null },
      });

      const again = await sell({ kind: 'WALK_IN', userId, method: 'CASH', denialId });
      expect(again.status).toBe(422);
      expect((again.body as Envelope<never>).error?.code).toBe('DENIAL_ALREADY_RESOLVED');
    });

    it('404s an unknown denial and takes no money', async () => {
      await withShift();

      const res = await sell({
        kind: 'WALK_IN',
        guestName: 'Nino',
        guestEmail: 'guest@example.com',
        guestWaiverAccepted: true,
        method: 'CASH',
        denialId: '00000000-0000-4000-8000-000000000000',
      });

      expect(res.status).toBe(404);
      // THE WHOLE TRANSACTION ROLLED BACK — no orphaned payment for a sale
      // that did not resolve anything.
      expect(await ctx.prisma.payment.count()).toBe(0);
      expect(await ctx.prisma.checkIn.count()).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────

  describe('the guest waiver gate', () => {
    it('refuses a guest sale with no waiver tick and stamps the version on one with it', async () => {
      await withShift();

      const refused = await sell({
        kind: 'WALK_IN',
        guestName: 'Nino',
        guestEmail: 'guest@example.com',
        method: 'CASH',
      });
      expect(refused.status).toBe(422);
      expect((refused.body as Envelope<never>).error?.code).toBe('GUEST_WAIVER_REQUIRED');
      expect(await ctx.prisma.checkIn.count()).toBe(0);

      const ok = await sell({
        kind: 'WALK_IN',
        guestName: 'Nino',
        guestEmail: 'guest@example.com',
        guestWaiverAccepted: true,
        guestEmergencyContact: 'Ana 0917 000 0000',
        method: 'CASH',
      });
      expect(ok.status).toBe(201);

      const entry = await ctx.prisma.checkIn.findFirstOrThrow();
      // Both or neither — CheckIn_guest_waiver_paired.
      expect(entry.guestWaiverVersion).not.toBeNull();
      expect(entry.guestWaiverAcceptedAt).not.toBeNull();
      expect(entry.guestEmergencyContact).toBe('Ana 0917 000 0000');
    });
  });

  // ───────────────────────────────────────────────────────────────────────

  describe('GET /front-desk/check-ins/:id/guest — the conversion hand-off', () => {
    const guestVisit = async (): Promise<string> => {
      await withShift();
      const res = await sell({
        kind: 'WALK_IN',
        guestName: 'Nino Cruz',
        guestEmail: 'guest@example.com',
        guestPhone: '0917 555 0101',
        guestEmergencyContact: 'Ana Cruz 0917 555 0102',
        guestWaiverAccepted: true,
        method: 'CASH',
      });
      return (res.body as Envelope<CheckInRecord>).data?.checkInId as string;
    };

    const fetchGuest = (id: string, token: string): request.Test =>
      request(server)
        .get(`/api/v1/front-desk/check-ins/${id}/guest`)
        .set('Authorization', `Bearer ${token}`);

    it('hands the guest contact to a holder of member.create', async () => {
      const checkInId = await guestVisit();
      const adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });

      const res = await fetchGuest(checkInId, adminToken);

      expect(res.status).toBe(200);
      expect((res.body as Envelope<Record<string, unknown>>).data).toEqual({
        guestName: 'Nino Cruz',
        guestEmail: 'guest@example.com',
        guestPhone: '0917 555 0101',
        guestEmergencyContact: 'Ana Cruz 0917 555 0102',
      });
    });

    /**
     * `checkin.read` is NOT enough — the desk feed deliberately never carries
     * a guest's phone, and this route must not become the side door. The gate
     * is the permission to create the account the data would seed.
     *
     * THE FRONT DESK NOW PASSES THAT GATE, and this test asserts the gate
     * rather than the outcome. `member.create` was ADMIN-only when this was
     * written; REQ005 says Admin OR Staff, and refusing the desk the ACCOUNT a
     * membership hangs off made the common counter flow "fetch an admin", so
     * the grant moved. The rule under test is unchanged: this route is gated on
     * `member.create`, not on `checkin.read`.
     *
     * COACH is the standing proof. They hold `checkin.read` (at OWN) and not
     * `member.create`, so they are exactly the caller this route must refuse.
     */
    it('403s a coach, who holds checkin.read but not member.create', async () => {
      const coachToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });
      const checkInId = await guestVisit();
      expect((await fetchGuest(checkInId, coachToken)).status).toBe(403);
    });

    it('lets the front desk through, which now holds member.create (REQ005)', async () => {
      const checkInId = await guestVisit();
      expect((await fetchGuest(checkInId, deskToken)).status).toBe(200);
    });

    it('404s a member visit — it never leaks a member row', async () => {
      await withShift();
      const member = await makeMember(ctx.prisma, { state: 'EXPIRED_PAST_GRACE', today: TODAY });
      await ctx.prisma.user.update({
        where: { id: member.userId },
        data: { avatarUrl: 'https://cdn.example/p.jpg' },
      });
      const res = await sell({ kind: 'WALK_IN', userId: member.userId, method: 'CASH' });
      const checkInId = (res.body as Envelope<CheckInRecord>).data?.checkInId as string;
      const adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });

      expect((await fetchGuest(checkInId, adminToken)).status).toBe(404);
    });
  });
});
