import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { addDays, gymToday, toDateColumn } from '../src/common/time/gym-time';
import {
  makeMember,
  openShift,
  seedPlansForTest,
  type SeededPlanIds,
} from './support/membership-fixtures';

jest.setTimeout(120_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface ShiftBody {
  id: string;
  status: string;
  businessDate: string;
  openedById: string;
  openedAt: string;
  openingFloatCentavos: number;
  closedById: string | null;
  closedAt: string | null;
  countedCentavos: number | null;
  note: string | null;
}

interface ClosureBody extends ShiftBody {
  expectedCentavos: number;
  varianceCentavos: number;
}

interface PaymentBody {
  id: string;
  userId: string | null;
  membershipId: string | null;
  purpose: string;
  status: string;
  grossCentavos: number;
  vatBaseCentavos: number;
  discountCentavos: number;
  netCentavos: number;
  vatExempt: boolean;
  statutoryIdNo: string | null;
  businessDate: string;
  reference: string | null;
  voidReason: string | null;
  voidedById: string | null;
  voidedAt: string | null;
}

interface PaymentListBody {
  items: PaymentBody[];
  total: number;
  totalCentavos: number;
  byMethod: { CASH: number; GCASH: number };
}

describe('payments & shifts (e2e)', () => {
  const TODAY = gymToday(new Date(), 'Asia/Manila');

  let ctx: TestApp;
  let server: Server;

  let adminToken: string;
  let frontDeskToken: string;
  let clientToken: string;
  let frontDeskId: string;

  let plans: SeededPlanIds;
  let adminId: string;
  let shiftId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('shifts (routes 38, 39, 40)', () => {
    beforeEach(async () => {
      await resetDatabase(ctx.prisma);
      await seedPlansForTest(ctx.prisma);
      adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
      frontDeskToken = await ctx.fixture.tokenFor('FRONT_DESK', {
        supabaseId: FIXTURE_IDS.FRONT_DESK,
      });
      clientToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
      frontDeskId = await ctx.fixture.userIdFor(FIXTURE_IDS.FRONT_DESK);
    });

    async function openDrawer(token: string, openingFloatCentavos = 300_000): Promise<ShiftBody> {
      const response = await request(server)
        .post('/api/v1/shifts/open')
        .set('Authorization', `Bearer ${token}`)
        .send({ openingFloatCentavos })
        .expect(201);
      return (response.body as Envelope<ShiftBody>).data as ShiftBody;
    }

    it('opens a drawer for FRONT_DESK and attributes it to the opener', async () => {
      const shift = await openDrawer(frontDeskToken);

      expect(shift.status).toBe('OPEN');
      expect(shift.openingFloatCentavos).toBe(300_000);
      expect(shift.openedById).toBe(frontDeskId);
      expect(shift.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(shift.closedAt).toBeNull();
    });

    // The whole mechanism: a visible expected total gets back-fitted every time.
    it('never discloses expectedCentavos on the open response', async () => {
      const shift = await openDrawer(frontDeskToken);

      expect(shift).not.toHaveProperty('expectedCentavos');
      expect(shift).not.toHaveProperty('varianceCentavos');
    });

    it('409s SHIFT_ALREADY_OPEN on a second open — one counter, one drawer', async () => {
      await openDrawer(frontDeskToken);

      const response = await request(server)
        .post('/api/v1/shifts/open')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ openingFloatCentavos: 300_000 })
        .expect(409);

      expect((response.body as Envelope<never>).error?.code).toBe('SHIFT_ALREADY_OPEN');
      expect(await ctx.prisma.shift.count()).toBe(1);
    });

    it('refuses a CLIENT: shift.manage is FRONT_DESK and ADMIN only', async () => {
      await request(server)
        .post('/api/v1/shifts/open')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ openingFloatCentavos: 300_000 })
        .expect(403);

      await request(server)
        .get('/api/v1/shifts/current')
        .set('Authorization', `Bearer ${clientToken}`)
        .expect(403);
    });

    it('400s a fractional or negative float — money is integer centavos', async () => {
      await request(server)
        .post('/api/v1/shifts/open')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .send({ openingFloatCentavos: 3000.5 })
        .expect(400);

      await request(server)
        .post('/api/v1/shifts/open')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .send({ openingFloatCentavos: -1 })
        .expect(400);
    });

    it('returns null from /shifts/current when no drawer is open', async () => {
      const response = await request(server)
        .get('/api/v1/shifts/current')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .expect(200);

      expect((response.body as Envelope<ShiftBody | null>).data).toBeNull();
    });

    it('returns the open drawer from /shifts/current, still without the expected figure', async () => {
      const opened = await openDrawer(frontDeskToken);

      const response = await request(server)
        .get('/api/v1/shifts/current')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .expect(200);

      const current = (response.body as Envelope<ShiftBody>).data as ShiftBody;
      expect(current.id).toBe(opened.id);
      expect(current).not.toHaveProperty('expectedCentavos');
    });

    it('closes on a blind count and discloses the expected figure only in that response', async () => {
      const shift = await openDrawer(frontDeskToken);

      const response = await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 300_000 })
        .expect(200);

      const closure = (response.body as Envelope<ClosureBody>).data as ClosureBody;
      expect(closure.status).toBe('CLOSED');
      expect(closure.countedCentavos).toBe(300_000);
      // No payments recorded yet, so the expectation is exactly the float.
      expect(closure.expectedCentavos).toBe(300_000);
      expect(closure.varianceCentavos).toBe(0);
      expect(closure.closedAt).not.toBeNull();
    });

    it('releases the sentinel so the next staffer can open a fresh drawer', async () => {
      const first = await openDrawer(frontDeskToken);
      await request(server)
        .post(`/api/v1/shifts/${first.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 300_000 })
        .expect(200);

      const closedRow = await ctx.prisma.shift.findUniqueOrThrow({ where: { id: first.id } });
      expect(closedRow.openMarker).toBeNull();

      const second = await openDrawer(adminToken, 250_000);
      expect(second.id).not.toBe(first.id);
      expect(await ctx.prisma.shift.count()).toBe(2);
    });

    it('422s SHIFT_VARIANCE_REASON_REQUIRED on a ₱250 gap with no note, and writes nothing', async () => {
      const shift = await openDrawer(frontDeskToken);

      const response = await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 275_000 })
        .expect(422);

      expect((response.body as Envelope<never>).error?.code).toBe('SHIFT_VARIANCE_REASON_REQUIRED');
      const row = await ctx.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
      expect(row.status).toBe('OPEN');
      expect(row.countedCentavos).toBeNull();
    });

    it('accepts the same gap with a note, and stores the signed variance', async () => {
      const shift = await openDrawer(frontDeskToken);

      const response = await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          countedCentavos: 275_000,
          note: 'paid the water delivery in cash, receipt in book',
        })
        .expect(200);

      const closure = (response.body as Envelope<ClosureBody>).data as ClosureBody;
      expect(closure.varianceCentavos).toBe(-25_000);
      expect(closure.note).toMatch(/water delivery/);

      const row = await ctx.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
      expect(row.varianceCentavos).toBe(-25_000);
      expect(row.expectedCentavos).toBe(300_000);
    });

    it('accepts a ₱150 gap with no note — inside the ±₱200 threshold', async () => {
      const shift = await openDrawer(frontDeskToken);

      const response = await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 285_000 })
        .expect(200);

      expect((response.body as Envelope<ClosureBody>).data?.varianceCentavos).toBe(-15_000);
    });

    it('409s SHIFT_ALREADY_CLOSED on a second close with a different key', async () => {
      const shift = await openDrawer(frontDeskToken);
      await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 300_000 })
        .expect(200);

      const response = await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 300_000 })
        .expect(409);

      expect((response.body as Envelope<never>).error?.code).toBe('SHIFT_ALREADY_CLOSED');
    });

    it('replays the stored closure verbatim for a repeated Idempotency-Key', async () => {
      const shift = await openDrawer(frontDeskToken);
      const key = randomUUID();

      const first = await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', key)
        .send({ countedCentavos: 300_000 })
        .expect(200);

      const replay = await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', key)
        .send({ countedCentavos: 300_000 })
        .expect(200);

      expect(replay.body).toEqual(first.body);
    });

    it('400s a close with no Idempotency-Key header', async () => {
      const shift = await openDrawer(frontDeskToken);

      await request(server)
        .post(`/api/v1/shifts/${shift.id}/close`)
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .send({ countedCentavos: 300_000 })
        .expect(400);
    });

    it('404s an unknown shift id', async () => {
      await request(server)
        .post('/api/v1/shifts/8f14e45f-ceea-4671-a3ab-9e2a5b3f0000/close')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 300_000 })
        .expect(404);
    });

    it('400s a non-uuid shift id before reaching the service', async () => {
      await request(server)
        .post('/api/v1/shifts/not-a-uuid/close')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ countedCentavos: 300_000 })
        .expect(400);
    });
  });

  describe('payments (routes 33, 34, 35)', () => {
    const TODAY = gymToday(new Date(), 'Asia/Manila');

    let adminToken: string;
    let deskToken: string;
    let adminId: string;
    let memberId: string;

    /** A fresh key per call: the interceptor rejects anything but a UUID v4. */
    function key(): string {
      return randomUUID();
    }

    function walkIn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        purpose: 'WALK_IN',
        planCode: 'WALKIN',
        grossCentavos: 9000,
        method: 'CASH',
        ...overrides,
      };
    }

    beforeEach(async () => {
      await resetDatabase(ctx.prisma);
      await seedPlansForTest(ctx.prisma);

      adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
      deskToken = await ctx.fixture.tokenFor('FRONT_DESK', { supabaseId: FIXTURE_IDS.FRONT_DESK });
      await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });

      adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
      memberId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);
    });

    describe('POST /payments', () => {
      beforeEach(async () => {
        await openShift(ctx.prisma, adminId, TODAY);
      });

      it('records a ₱90 walk-in as integer centavos, with no formatted currency anywhere', async () => {
        const response = await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', key())
          .send(walkIn({ userId: memberId }))
          .expect(201);

        const payment = (response.body as Envelope<PaymentBody>).data as PaymentBody;
        expect(payment.grossCentavos).toBe(9000);
        expect(payment.vatBaseCentavos).toBe(9000);
        expect(payment.discountCentavos).toBe(0);
        expect(payment.netCentavos).toBe(9000);
        expect(payment.vatExempt).toBe(false);
        expect(payment.status).toBe('RECORDED');
        expect(payment.purpose).toBe('WALK_IN');
        expect(payment.membershipId).toBeNull();
        expect(payment.businessDate).toBe(TODAY);
        expect(JSON.stringify(response.body)).not.toMatch(/₱|PHP/);

        const rows = await ctx.prisma.payment.findMany();
        expect(rows).toHaveLength(1);
        expect(rows[0].shiftId).not.toBeNull();
        expect(rows[0].recordedById).toBe(await ctx.fixture.userIdFor(FIXTURE_IDS.FRONT_DESK));
      });

      it('records an off-the-street guest with no account at all', async () => {
        const response = await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', key())
          .send(walkIn())
          .expect(201);

        expect((response.body as Envelope<PaymentBody>).data?.userId).toBeNull();
      });

      it('replays one key to 200 with the same row and writes exactly one Payment', async () => {
        const idempotencyKey = key();
        const body = walkIn({ userId: memberId });

        const first = await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', idempotencyKey)
          .send(body)
          .expect(201);

        const second = await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', idempotencyKey)
          .send(body)
          .expect(200);

        const firstBody = first.body as Envelope<PaymentBody>;
        const secondBody = second.body as Envelope<Record<string, unknown>>;
        expect(secondBody.data?.['id']).toBe(firstBody.data?.id);
        expect(secondBody.success).toBe(true);
        // Exactly one envelope on the replay, not a nested one.
        expect(secondBody.data?.['data']).toBeUndefined();
        expect(await ctx.prisma.payment.count()).toBe(1);
      });

      it('refuses the same key with a different body: 409, and no second row', async () => {
        const idempotencyKey = key();

        await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', idempotencyKey)
          .send(walkIn())
          .expect(201);

        // The case §5.7.5 exists for: returning the ₱90 receipt for an ₱8,000
        // request is worse than no idempotency, because it looks like success.
        const response = await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', idempotencyKey)
          .send(walkIn({ planCode: 'MONTHLY', grossCentavos: 80000 }))
          .expect(409);

        expect((response.body as Envelope<never>).error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
        expect(await ctx.prisma.payment.count()).toBe(1);
      });

      it('rejects a request with no Idempotency-Key header at all', async () => {
        await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .send(walkIn())
          .expect(400);
      });

      it('computes the statutory 20% itself — staff never type the amount', async () => {
        const response = await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', key())
          .send(
            walkIn({
              userId: memberId,
              discountType: 'SENIOR',
              statutoryIdNo: 'OSCA-TAG-114532',
            }),
          )
          .expect(201);

        // GYM_VAT_REGISTERED defaults false, so vatBase is the gross and the
        // whole 20% comes off it: 9000 → 1800 → 7200.
        const payment = (response.body as Envelope<PaymentBody>).data as PaymentBody;
        expect(payment.vatExempt).toBe(false);
        expect(payment.vatBaseCentavos).toBe(9000);
        expect(payment.discountCentavos).toBe(1800);
        expect(payment.netCentavos).toBe(7200);
        expect(payment.statutoryIdNo).toBe('OSCA-TAG-114532');
      });

      it('refuses a SENIOR discount with no OSCA/PWD ID — BIR keeps that record', async () => {
        const response = await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', key())
          .send(walkIn({ discountType: 'SENIOR' }))
          .expect(422);

        expect((response.body as Envelope<never>).error?.code).toBe('STATUTORY_ID_REQUIRED');
        expect(await ctx.prisma.payment.count()).toBe(0);
      });

      it('refuses FRONT_DESK a GOODWILL discount but allows ADMIN a ₱0 comp', async () => {
        const refused = await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', key())
          .send(
            walkIn({
              discountType: 'GOODWILL',
              discountCentavos: 9000,
              discountReason: 'apology for the aircon',
            }),
          )
          .expect(403);
        expect((refused.body as Envelope<never>).error?.message).toContain(
          'payment.discount.grant',
        );

        const allowed = await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('Idempotency-Key', key())
          .send(
            walkIn({
              discountType: 'GOODWILL',
              discountCentavos: 9000,
              discountReason: 'apology for the aircon',
            }),
          )
          .expect(201);

        // netCentavos = 0 is legal exactly because the type is a comp type.
        const allowedPayment = (allowed.body as Envelope<PaymentBody>).data as PaymentBody;
        expect(allowedPayment.netCentavos).toBe(0);
        expect(allowedPayment.grossCentavos).toBe(9000);
      });

      it('refuses a discretionary discount with no reason', async () => {
        const response = await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('Idempotency-Key', key())
          .send(walkIn({ discountType: 'PROMO', discountCentavos: 1000 }))
          .expect(422);

        expect((response.body as Envelope<never>).error?.code).toBe('DISCOUNT_ID_REQUIRED');
      });

      it('refuses GCASH with no reference — an unreconcilable GCash row is worthless', async () => {
        const response = await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', key())
          .send(walkIn({ method: 'GCASH' }))
          .expect(422);

        expect((response.body as Envelope<never>).error?.code).toBe('GCASH_REFERENCE_REQUIRED');
      });

      it('refuses a gross that disagrees with the price list', async () => {
        const response = await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', key())
          .send(walkIn({ grossCentavos: 8000 }))
          .expect(422);

        expect((response.body as Envelope<never>).error?.code).toBe('PAYMENT_AMOUNT_MISMATCH');
      });

      it('refuses a MEMBERSHIP purpose: a term is sold through POST /memberships', async () => {
        const response = await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', key())
          .send(walkIn({ purpose: 'MEMBERSHIP', planCode: 'MONTHLY', grossCentavos: 80000 }))
          .expect(422);

        expect((response.body as Envelope<never>).error?.code).toBe('PAYMENT_SHAPE_INVALID');
      });

      it('refuses a CLIENT outright — no member records their own money', async () => {
        const clientToken = await ctx.fixture.tokenFor('CLIENT', {
          supabaseId: FIXTURE_IDS.CLIENT_A,
        });

        await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${clientToken}`)
          .set('Idempotency-Key', key())
          .send(walkIn())
          .expect(403);
      });
    });

    it('refuses to record anything with no open drawer', async () => {
      const response = await request(server)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${deskToken}`)
        .set('Idempotency-Key', key())
        .send(walkIn())
        .expect(422);

      expect((response.body as Envelope<never>).error?.code).toBe('SHIFT_NOT_OPEN');
      expect(await ctx.prisma.payment.count()).toBe(0);
    });

    describe('GET /payments and POST /payments/:id/void', () => {
      let cashId: string;

      beforeEach(async () => {
        await openShift(ctx.prisma, adminId, TODAY);

        const cash = await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', key())
          .send(walkIn({ userId: memberId }))
          .expect(201);
        cashId = ((cash.body as Envelope<PaymentBody>).data as PaymentBody).id;

        await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', key())
          .send(walkIn())
          .expect(201);

        await request(server)
          .post('/api/v1/payments')
          .set('Authorization', `Bearer ${deskToken}`)
          .set('Idempotency-Key', key())
          .send(walkIn({ method: 'GCASH', reference: 'GC-8842019' }))
          .expect(201);
      });

      it('voids with who and why, and refuses a second void', async () => {
        const voided = await request(server)
          .post(`/api/v1/payments/${cashId}/void`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ confirm: true, reason: 'rang the wrong plan', kind: 'VOID' })
          .expect(200);

        const voidedPayment = (voided.body as Envelope<PaymentBody>).data as PaymentBody;
        expect(voidedPayment.status).toBe('VOIDED');
        expect(voidedPayment.voidReason).toBe('rang the wrong plan');
        expect(voidedPayment.voidedById).toBe(adminId);
        expect(voidedPayment.voidedAt).not.toBeNull();
        // A void is never a delete: the drawer still has to reconcile.
        expect(await ctx.prisma.payment.count()).toBe(3);

        const again = await request(server)
          .post(`/api/v1/payments/${cashId}/void`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ confirm: true, reason: 'again', kind: 'VOID' })
          .expect(422);
        expect((again.body as Envelope<never>).error?.code).toBe('PAYMENT_ALREADY_VOIDED');
      });

      it('refuses a void with no confirm, and a void from FRONT_DESK', async () => {
        const unconfirmed = await request(server)
          .post(`/api/v1/payments/${cashId}/void`)
          .set('Authorization', `Bearer ${adminToken}`)
          // `kind` IS sent: it is a mandatory @IsEnum field, so omitting it
          // would make the ValidationPipe 400 first and this assertion would
          // pass on the wrong error. The only thing missing here is `confirm`.
          .send({ reason: 'oops', kind: 'VOID' })
          .expect(400);
        expect((unconfirmed.body as Envelope<never>).error?.code).toBe('CONFIRMATION_REQUIRED');

        // §5.7.6's desk self-void is deliberately not built in chunk 1: one
        // route cannot carry two permission keys.
        await request(server)
          .post(`/api/v1/payments/${cashId}/void`)
          .set('Authorization', `Bearer ${deskToken}`)
          .send({ confirm: true, reason: 'mine to fix', kind: 'VOID' })
          .expect(403);
      });

      it('404s an unknown payment id rather than leaking that it does not exist', async () => {
        const response = await request(server)
          .post('/api/v1/payments/0b000000-0000-4000-8000-00000000ff01/void')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ confirm: true, reason: 'nothing there', kind: 'VOID' })
          .expect(404);

        expect((response.body as Envelope<never>).error?.code).toBe('PAYMENT_NOT_FOUND');
      });

      it('totals RECORDED money only, split by method', async () => {
        await request(server)
          .post(`/api/v1/payments/${cashId}/void`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ confirm: true, reason: 'rang the wrong plan', kind: 'VOID' })
          .expect(200);

        const response = await request(server)
          .get('/api/v1/payments')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        const data = (response.body as Envelope<PaymentListBody>).data as PaymentListBody;
        expect(data.total).toBe(3);
        expect(data.totalCentavos).toBe(18000);
        expect(data.byMethod).toEqual({ CASH: 9000, GCASH: 9000 });
      });

      it('filters by method and by businessDate range', async () => {
        const byMethod = await request(server)
          .get('/api/v1/payments?method=GCASH')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        const byMethodData = (byMethod.body as Envelope<PaymentListBody>).data as PaymentListBody;
        expect(byMethodData.items).toHaveLength(1);
        expect(byMethodData.items[0]?.reference).toBe('GC-8842019');

        const empty = await request(server)
          .get('/api/v1/payments?from=2020-01-01&to=2020-01-31')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        const emptyData = (empty.body as Envelope<PaymentListBody>).data as PaymentListBody;
        expect(emptyData.items).toEqual([]);
        expect(emptyData.totalCentavos).toBe(0);
      });

      it('rejects a from= that is a timestamp rather than a civil date', async () => {
        await request(server)
          .get('/api/v1/payments?from=2026-08-19T00:00:00.000Z')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(400);
      });
    });
  });

  describe('reports (routes 36, 37)', () => {
    beforeEach(async () => {
      await resetDatabase(ctx.prisma);
      plans = await seedPlansForTest(ctx.prisma);
      adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
      adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
      shiftId = await openShift(ctx.prisma, adminId, TODAY);
    });

    it('returns the BIR statutory register with centavo integers and the ID number', async () => {
      const member = await makeMember(ctx.prisma, {
        state: 'ACTIVE',
        planCode: 'MONTHLY',
        today: TODAY,
      });

      await ctx.prisma.payment.create({
        data: {
          userId: member.userId,
          membershipId: member.membershipId,
          planId: plans.MONTHLY,
          purpose: 'MEMBERSHIP',
          planCode: 'MONTHLY',
          planName: 'Monthly',
          grossCentavos: 80000,
          vatBaseCentavos: 80000,
          discountType: 'SENIOR',
          discountCentavos: 16000,
          netCentavos: 64000,
          vatExempt: false,
          statutoryIdNo: 'OSCA-2019-004412',
          termMonths: 1,
          termStartsOn: toDateColumn(TODAY),
          termEndsOn: toDateColumn(addDays(TODAY, 30)),
          method: 'CASH',
          receivedAt: new Date(),
          businessDate: toDateColumn(TODAY),
          shiftId,
          recordedById: adminId,
          idempotencyKey: 'report-senior-1',
          idempotencyHash: 'a'.repeat(64),
        },
      });

      const response = await request(server)
        .get(`/api/v1/reports/statutory-discounts?from=${TODAY}&to=${TODAY}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.data.totalDiscountCentavos).toBe(16000);
      expect(response.body.data.rows).toHaveLength(1);
      expect(response.body.data.rows[0]).toMatchObject({
        discountType: 'SENIOR',
        statutoryIdNo: 'OSCA-2019-004412',
        grossCentavos: 80000,
        netCentavos: 64000,
        businessDate: TODAY,
      });
      expect(JSON.stringify(response.body)).not.toContain('₱');
    });

    it('lists GCash references for statement matching and excludes cash', async () => {
      const member = await makeMember(ctx.prisma, {
        state: 'ACTIVE',
        planCode: 'QUARTERLY',
        today: TODAY,
      });

      await ctx.prisma.payment.create({
        data: {
          userId: member.userId,
          membershipId: member.membershipId,
          planId: plans.QUARTERLY,
          purpose: 'MEMBERSHIP',
          planCode: 'QUARTERLY',
          planName: 'Quarterly',
          grossCentavos: 220000,
          vatBaseCentavos: 220000,
          discountCentavos: 0,
          netCentavos: 220000,
          termMonths: 3,
          termStartsOn: toDateColumn(TODAY),
          termEndsOn: toDateColumn(addDays(TODAY, 90)),
          method: 'GCASH',
          reference: 'GC-8842019',
          // Payment_reference_normalized_shape: the pair moves together on a
          // raw create; the service derives this itself.
          referenceNormalized: 'GC8842019',
          receivedAt: new Date(),
          businessDate: toDateColumn(TODAY),
          shiftId,
          recordedById: adminId,
          idempotencyKey: 'report-gcash-1',
          idempotencyHash: 'b'.repeat(64),
        },
      });

      const response = await request(server)
        .get(`/api/v1/reports/gcash?from=${TODAY}&to=${TODAY}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.data.totalCentavos).toBe(220000);
      expect(response.body.data.rows[0].reference).toBe('GC-8842019');
    });

    it('400s on an instant where a civil date is required', async () => {
      await request(server)
        .get('/api/v1/reports/gcash?from=2026-08-19T00:00:00Z&to=2026-08-19')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('refuses a COACH, who holds no payment key at any scope', async () => {
      const coachToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });
      await request(server)
        .get(`/api/v1/reports/statutory-discounts?from=${TODAY}&to=${TODAY}`)
        .set('Authorization', `Bearer ${coachToken}`)
        .expect(403);
    });
  });
});
