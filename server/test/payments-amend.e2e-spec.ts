import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { gymToday } from '../src/common/time/gym-time';
import { openShift, seedPlansForTest } from './support/membership-fixtures';

jest.setTimeout(120_000);

/**
 * "Edit payment" end to end: the void-and-re-record correction, and the
 * archive soft delete beside it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE THINGS THAT WOULD FAIL SILENTLY, ASSERTED HERE.
 *
 *  1. The void UPDATE must precede the replacement INSERT, or the GCash
 *     partial unique index refuses every correction that keeps its reference.
 *     "Same reference survives an amend" is that ordering's only observable.
 *  2. `CheckIn.paymentId` must MOVE to the replacement, or `walkInStats` reads
 *     the amended day pass as ₱0 forever with no error anywhere.
 *  3. Archiving a RECORDED payment must not change `GET /reports/revenue`.
 *     That is the whole soft-delete contract; if it ever fails, `archivedAt`
 *     has been wired into something that counts.
 * ═══════════════════════════════════════════════════════════════════════════
 */

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface PaymentBody {
  id: string;
  userId: string | null;
  status: string;
  planCode: string;
  method: string;
  reference: string | null;
  receiptNo: string | null;
  grossCentavos: number;
  netCentavos: number;
  businessDate: string;
  receivedAt: string;
  shiftId: string;
  recordedById: string;
  voidReason: string | null;
  voidKind: string | null;
}

interface PaymentDetailBody extends PaymentBody {
  docNo: string;
  replacesPaymentId: string | null;
  replacedByPaymentId: string | null;
  hasProof: boolean;
  vatRegistered: boolean;
  checkIn: { id: string; occurredAt: string; guestName: string | null } | null;
}

interface PaymentListBody {
  items: PaymentBody[];
  total: number;
  totalCentavos: number;
  byMethod: { CASH: number; GCASH: number };
}

interface RevenueBody {
  series: { key: string; label: string; centavos: number }[];
  totalCentavos: number;
}

interface WalkInStatsBody {
  revenueCentavos: number;
}

describe('payment amend and archive (e2e)', () => {
  const TODAY = gymToday(new Date(), 'Asia/Manila');

  let ctx: TestApp;
  let server: Server;
  let adminToken: string;
  let deskToken: string;
  let adminId: string;
  let memberId: string;
  let shiftId: string;

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
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    deskToken = await ctx.fixture.tokenFor('FRONT_DESK', { supabaseId: FIXTURE_IDS.FRONT_DESK });
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
    adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    memberId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);
    shiftId = await openShift(ctx.prisma, adminId, TODAY);
  });

  const record = (body: Record<string, unknown> = {}): Promise<PaymentBody> =>
    request(server)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${deskToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ purpose: 'WALK_IN', planCode: 'WALKIN', grossCentavos: 9000, method: 'CASH', ...body })
      .expect(201)
      .then((res) => (res.body as Envelope<PaymentBody>).data as PaymentBody);

  const amend = (id: string, body: Record<string, unknown>, token = adminToken): request.Test =>
    request(server)
      .post(`/api/v1/payments/${id}/amend`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: true, ...body });

  const detail = (id: string): Promise<PaymentDetailBody> =>
    request(server)
      .get(`/api/v1/payments/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
      .then((res) => (res.body as Envelope<PaymentDetailBody>).data as PaymentDetailBody);

  // ────────────────────────────────────────────────────────────────────────

  describe('the GCash partial index releases on void', () => {
    /**
     * `Payment_gcash_reference_unique` is partial on
     * (referenceNormalized) WHERE method='GCASH' AND status<>'VOIDED'.
     * The amend voids first, inside the same transaction, so the corrected
     * row may carry the SAME reference. Insert-before-void fails here.
     */
    it('amends a GCASH payment keeping its reference', async () => {
      const original = await record({ method: 'GCASH', reference: '6028 871 884223' });

      const res = await amend(original.id, {
        reason: 'rang the wrong plan',
        planCode: 'MONTHLY',
      }).expect(200);

      const replacement = (res.body as Envelope<PaymentBody>).data as PaymentBody;
      expect(replacement.id).not.toBe(original.id);
      expect(replacement.reference).toBe('6028 871 884223');
      expect(replacement.status).toBe('RECORDED');
      expect(replacement.netCentavos).toBe(80_000);

      const before = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: original.id } });
      expect(before.status).toBe('VOIDED');
      expect(before.voidReason).toBe('Amended — rang the wrong plan');
      expect(before.voidKind).toBe('VOID');
    });

    it('still refuses a reference that is live on a DIFFERENT payment', async () => {
      const other = await record({ method: 'GCASH', reference: 'GC-111111' });
      const original = await record({ method: 'GCASH', reference: 'GC-222222' });
      expect(other.id).not.toBe(original.id);

      const res = await amend(original.id, {
        reason: 'wrong reference typed',
        reference: 'GC-111111',
      }).expect(409);
      expect((res.body as Envelope<never>).error?.code).toBe('GCASH_REFERENCE_DUPLICATE');

      // The whole transaction rolled back: the original is STILL live.
      const untouched = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: original.id } });
      expect(untouched.status).toBe('RECORDED');
      expect(untouched.voidedAt).toBeNull();
      expect(await ctx.prisma.payment.count()).toBe(2);
    });
  });

  describe('shifts', () => {
    /**
     * §1.1. An amend moves no money — it restates a row whose cash was
     * already counted. `requireOpenShiftId` is deliberately not consulted.
     */
    it('amends a payment in a CLOSED shift with no shift open at all', async () => {
      const original = await record();

      const closed = await request(server)
        .post(`/api/v1/shifts/${shiftId}/close`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 209_000 })
        .expect(200);
      const closure = (closed.body as Envelope<{ expectedCentavos: number; varianceCentavos: number }>)
        .data as { expectedCentavos: number; varianceCentavos: number };

      // No drawer is open now. The amend must still land.
      const res = await amend(original.id, {
        reason: 'wrong plan rung',
        planCode: 'MONTHLY',
      }).expect(200);
      const replacement = (res.body as Envelope<PaymentBody>).data as PaymentBody;

      expect(replacement.shiftId).toBe(shiftId);
      expect(replacement.businessDate).toBe(original.businessDate);
      expect(replacement.receivedAt).toBe(original.receivedAt);

      /*
       * THE CONSEQUENCE, SAID OUT LOUD. A closed shift's figures are
       * SNAPSHOTS taken at close and are never recomputed, so they no longer
       * equal openingFloat + SUM(net) over the shift's current rows. That is
       * correct: they record what was expected WHEN THE DRAWER WAS COUNTED.
       * This is already true of void() today.
       */
      const stored = await ctx.prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
      expect(stored.expectedCentavos).toBe(closure.expectedCentavos);
      expect(stored.varianceCentavos).toBe(closure.varianceCentavos);
      expect(stored.expectedCentavos).toBe(209_000);
    });

    it('moves what an OPEN shift expects before it is counted', async () => {
      const original = await record();

      await amend(original.id, { reason: 'wrong plan rung', planCode: 'MONTHLY' }).expect(200);

      const closed = await request(server)
        .post(`/api/v1/shifts/${shiftId}/close`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 280_000 })
        .expect(200);
      const closure = (closed.body as Envelope<{ expectedCentavos: number }>).data as {
        expectedCentavos: number;
      };

      // 200,000 float + the CORRECTED 80,000, never the voided 9,000.
      expect(closure.expectedCentavos).toBe(280_000);
    });
  });

  describe('reports', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════
     * STEP 5 OF THE AMEND TRANSACTION, OBSERVED.
     *
     * `walkInStats` reads `CheckIn.payment.status`. Leave the visit pointing
     * at the voided original and the corrected day pass reads as ₱0 forever,
     * with no error anywhere.
     * ═══════════════════════════════════════════════════════════════════
     */
    it('re-points the funded walk-in visit, so walk-in revenue is the NEW figure', async () => {
      const sold = await request(server)
        .post('/api/v1/front-desk/walk-ins')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          kind: 'WALK_IN',
          guestName: 'Nino Cruz',
          guestEmail: 'guest@example.com',
          guestWaiverAccepted: true,
          method: 'CASH',
        })
        .expect(201);
      expect(sold.body).toBeDefined();

      const payment = await ctx.prisma.payment.findFirstOrThrow({
        where: { purpose: 'WALK_IN' },
        select: { id: true },
      });

      const before = await request(server)
        .get(`/api/v1/reports/walk-ins?from=${TODAY}&to=${TODAY}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(((before.body as Envelope<WalkInStatsBody>).data as WalkInStatsBody).revenueCentavos)
        .toBe(9000);

      const res = await amend(payment.id, {
        reason: 'rang the day pass at the wrong price',
        planCode: 'MONTHLY',
      }).expect(200);
      const replacement = (res.body as Envelope<PaymentBody>).data as PaymentBody;

      const visit = await ctx.prisma.checkIn.findFirstOrThrow({
        where: { entryType: 'WALK_IN' },
        select: { paymentId: true },
      });
      // MOVED, not cleared — CheckIn_entry_shape requires it NOT NULL.
      expect(visit.paymentId).toBe(replacement.id);

      const after = await request(server)
        .get(`/api/v1/reports/walk-ins?from=${TODAY}&to=${TODAY}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(((after.body as Envelope<WalkInStatsBody>).data as WalkInStatsBody).revenueCentavos)
        .toBe(80_000);
    });

    it('moves revenue for the day by the delta and nothing else', async () => {
      const original = await record({ userId: memberId });

      const before = await request(server)
        .get(`/api/v1/reports/revenue?from=${TODAY}&to=${TODAY}&groupBy=method`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const beforeTotal = ((before.body as Envelope<RevenueBody>).data as RevenueBody).totalCentavos;
      expect(beforeTotal).toBe(9000);

      await amend(original.id, { reason: 'wrong plan rung', planCode: 'MONTHLY' }).expect(200);

      const after = await request(server)
        .get(`/api/v1/reports/revenue?from=${TODAY}&to=${TODAY}&groupBy=method`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(((after.body as Envelope<RevenueBody>).data as RevenueBody).totalCentavos).toBe(80_000);
    });
  });

  describe('permissions and refusals', () => {
    it('403s FRONT_DESK on amend but lets them read the detail', async () => {
      const original = await record();

      await amend(original.id, { reason: 'not mine to do' }, deskToken).expect(403);

      await request(server)
        .get(`/api/v1/payments/${original.id}`)
        .set('Authorization', `Bearer ${deskToken}`)
        .expect(200);
    });

    it('refuses a second amend of the same original', async () => {
      const original = await record();
      await amend(original.id, { reason: 'wrong plan rung', planCode: 'MONTHLY' }).expect(200);

      const again = await amend(original.id, { reason: 'again' }).expect(422);
      expect((again.body as Envelope<never>).error?.code).toBe('PAYMENT_ALREADY_AMENDED');
    });

    it('refuses an amend with no confirmation', async () => {
      const original = await record();
      const res = await request(server)
        .post(`/api/v1/payments/${original.id}/amend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'no confirm sent' })
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe('CONFIRMATION_REQUIRED');
    });
  });

  describe('GET /payments/:id', () => {
    it('exposes both ends of the amendment chain and the same docNo the slip prints', async () => {
      const original = await record();
      const res = await amend(original.id, {
        reason: 'wrong plan rung',
        planCode: 'MONTHLY',
      }).expect(200);
      const replacement = (res.body as Envelope<PaymentBody>).data as PaymentBody;

      const originalDetail = await detail(original.id);
      const replacementDetail = await detail(replacement.id);

      expect(originalDetail.replacedByPaymentId).toBe(replacement.id);
      expect(originalDetail.replacesPaymentId).toBeNull();
      expect(replacementDetail.replacesPaymentId).toBe(original.id);
      expect(replacementDetail.replacedByPaymentId).toBeNull();

      const slip = await request(server)
        .get(`/api/v1/payments/${replacement.id}/receipt`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(replacementDetail.docNo).toBe(
        ((slip.body as Envelope<{ docNo: string }>).data as { docNo: string }).docNo,
      );
    });

    it('never ships proofPath, referenceNormalized, the idempotency pair or guestPhone', async () => {
      const original = await record({ method: 'GCASH', reference: '6028 871 884223' });
      const body = await detail(original.id);

      for (const forbidden of [
        'proofPath',
        'referenceNormalized',
        'idempotencyKey',
        'idempotencyHash',
        'guestPhone',
        'planId',
      ]) {
        expect(Object.keys(body)).not.toContain(forbidden);
      }
      expect(typeof body.hasProof).toBe('boolean');
    });
  });

  describe('archive — the soft-delete contract', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════
     * THE MOST IMPORTANT ARCHIVE TEST.
     *
     * Archiving a RECORDED payment changes what the REGISTER SHOWS and
     * nothing else. No report, shift closure or BIR register reads
     * `archivedAt` — exactly as none of them reads `User.deletedAt`. If this
     * ever fails, the column has been wired into something that counts.
     * ═══════════════════════════════════════════════════════════════════
     */
    it('does NOT change reports/revenue when a RECORDED payment is archived', async () => {
      const original = await record({ userId: memberId });

      const before = await request(server)
        .get(`/api/v1/reports/revenue?from=${TODAY}&to=${TODAY}&groupBy=method`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      await request(server)
        .post(`/api/v1/payments/${original.id}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const after = await request(server)
        .get(`/api/v1/reports/revenue?from=${TODAY}&to=${TODAY}&groupBy=method`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect((after.body as Envelope<RevenueBody>).data).toEqual(
        (before.body as Envelope<RevenueBody>).data,
      );
    });

    it('hides the row from the default list and shows it under archived=true', async () => {
      const original = await record();
      await record();

      await request(server)
        .post(`/api/v1/payments/${original.id}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const visible = await request(server)
        .get('/api/v1/payments')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const visibleData = (visible.body as Envelope<PaymentListBody>).data as PaymentListBody;
      expect(visibleData.items.map((row) => row.id)).not.toContain(original.id);
      expect(visibleData.total).toBe(1);

      const archived = await request(server)
        .get('/api/v1/payments?archived=true')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const archivedData = (archived.body as Envelope<PaymentListBody>).data as PaymentListBody;
      expect(archivedData.items.map((row) => row.id)).toEqual([original.id]);
    });

    it('is reversible, and refuses the no-op in both directions', async () => {
      const original = await record();

      await request(server)
        .post(`/api/v1/payments/${original.id}/unarchive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(422)
        .then((res) =>
          expect((res.body as Envelope<never>).error?.code).toBe('PAYMENT_NOT_ARCHIVED'),
        );

      await request(server)
        .post(`/api/v1/payments/${original.id}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      await request(server)
        .post(`/api/v1/payments/${original.id}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(422)
        .then((res) =>
          expect((res.body as Envelope<never>).error?.code).toBe('PAYMENT_ALREADY_ARCHIVED'),
        );

      await request(server)
        .post(`/api/v1/payments/${original.id}/unarchive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: original.id } });
      expect(row.archivedAt).toBeNull();
      expect(row.archivedById).toBeNull();
    });

    it('403s FRONT_DESK on both archive routes', async () => {
      const original = await record();
      await request(server)
        .post(`/api/v1/payments/${original.id}/archive`)
        .set('Authorization', `Bearer ${deskToken}`)
        .expect(403);
      await request(server)
        .post(`/api/v1/payments/${original.id}/unarchive`)
        .set('Authorization', `Bearer ${deskToken}`)
        .expect(403);
    });
  });
});
