import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { seedPlansForTest } from './support/membership-fixtures';
import { seedPlans } from '../src/catalogue/plan-registry';

jest.setTimeout(120_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface PublicPlanBody {
  code: string;
  name: string;
  description: string | null;
  kind: string;
  priceCentavos: number;
  termMonths: number | null;
  freezable: boolean;
  guestPassesPerTerm: number;
  graceDays: number;
  perks: string[];
  sortOrder: number;
}

interface AdminPlanBody extends PublicPlanBody {
  id: string;
  isActive: boolean;
}

describe('plans (e2e)', () => {
  let ctx: TestApp;
  let server: Server;

  let adminToken: string;
  let frontDeskToken: string;
  let clientToken: string;
  let planIds: Record<'WALKIN' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL', string>;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    planIds = await seedPlansForTest(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    frontDeskToken = await ctx.fixture.tokenFor('FRONT_DESK', {
      supabaseId: FIXTURE_IDS.FRONT_DESK,
    });
    clientToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
  });

  describe('GET /plans (route 5)', () => {
    it('serves the price list with no token at all', async () => {
      const response = await request(server).get('/api/v1/plans').expect(200);

      const body = response.body as Envelope<PublicPlanBody[]>;
      expect(body.data?.map((plan) => plan.code)).toEqual([
        'WALKIN',
        'MONTHLY',
        'QUARTERLY',
        'ANNUAL',
      ]);
    });

    it('ships integer centavos and never a formatted currency string', async () => {
      const response = await request(server).get('/api/v1/plans').expect(200);

      const plans = (response.body as Envelope<PublicPlanBody[]>).data ?? [];
      const walkIn = plans.find((plan) => plan.code === 'WALKIN');
      expect(walkIn?.priceCentavos).toBe(9000);
      expect(walkIn?.termMonths).toBeNull();
      expect(plans.find((plan) => plan.code === 'ANNUAL')?.priceCentavos).toBe(750000);
      expect(JSON.stringify(plans)).not.toMatch(/₱|PHP/);
    });

    // The uuid is a database identifier. Every purchase path names a plan by
    // `code` — the column snapshotted onto Membership and Payment — so shipping
    // the id to an unauthenticated page invites a client to POST it.
    it('omits the plan id and the isActive flag from the public projection', async () => {
      const response = await request(server).get('/api/v1/plans').expect(200);

      for (const plan of (response.body as Envelope<PublicPlanBody[]>).data ?? []) {
        expect(plan).not.toHaveProperty('id');
        expect(plan).not.toHaveProperty('isActive');
      }
    });

    it('hides an archived plan from the public list', async () => {
      await request(server)
        .post(`/api/v1/admin/plans/${planIds.QUARTERLY}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const response = await request(server).get('/api/v1/plans').expect(200);
      const codes = ((response.body as Envelope<PublicPlanBody[]>).data ?? []).map((p) => p.code);
      expect(codes).toEqual(['WALKIN', 'MONTHLY', 'ANNUAL']);
    });
  });

  describe('GET /admin/plans (route 6)', () => {
    it('paginates the active list for a FRONT_DESK holder of plan.read', async () => {
      const response = await request(server)
        .get('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .expect(200);

      const body = response.body as Envelope<{ items: AdminPlanBody[]; total: number }>;
      expect(body.data?.total).toBe(4);
      expect(body.data?.items[0].id).toEqual(expect.any(String));
      expect(body.data?.items[0].isActive).toBe(true);
    });

    it('excludes archived plans unless includeInactive=true', async () => {
      await request(server)
        .post(`/api/v1/admin/plans/${planIds.WALKIN}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const hidden = await request(server)
        .get('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect((hidden.body as Envelope<{ total: number }>).data?.total).toBe(3);

      const shown = await request(server)
        .get('/api/v1/admin/plans?includeInactive=true')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect((shown.body as Envelope<{ total: number }>).data?.total).toBe(4);
    });

    it('filters by kind', async () => {
      const response = await request(server)
        .get('/api/v1/admin/plans?kind=WALK_IN')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const items = (response.body as Envelope<{ items: AdminPlanBody[] }>).data?.items ?? [];
      expect(items.map((plan) => plan.code)).toEqual(['WALKIN']);
    });
  });

  describe('POST /admin/plans (route 7)', () => {
    it('creates a plan for an ADMIN', async () => {
      const response = await request(server)
        .post('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: 'SEMIANNUAL',
          name: 'Semi-annual',
          description: 'Six months.',
          kind: 'TERM',
          priceCentavos: 420000,
          termMonths: 6,
          freezable: true,
          graceDays: 3,
          guestPassesPerTerm: 1,
          perks: ['Full gym access'],
          sortOrder: 4,
        })
        .expect(201);

      const plan = (response.body as Envelope<AdminPlanBody>).data;
      expect(plan?.code).toBe('SEMIANNUAL');
      expect(plan?.priceCentavos).toBe(420000);
      expect(plan?.isActive).toBe(true);
    });

    it('refuses a FRONT_DESK caller: plan.manage is ADMIN only', async () => {
      await request(server)
        .post('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${frontDeskToken}`)
        .send({ code: 'NOPE', name: 'Nope', kind: 'TERM', priceCentavos: 80000, termMonths: 1 })
        .expect(403);
    });

    it('refuses a CLIENT caller outright', async () => {
      await request(server)
        .post('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ code: 'NOPE', name: 'Nope', kind: 'TERM', priceCentavos: 80000, termMonths: 1 })
        .expect(403);
    });

    it('409s on a duplicate code — the code is the snapshot key and is never reused', async () => {
      await request(server)
        .post('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: 'MONTHLY',
          name: 'Monthly again',
          kind: 'TERM',
          priceCentavos: 90000,
          termMonths: 1,
        })
        .expect(409);
    });

    it('400s a WALK_IN plan that carries a term', async () => {
      const response = await request(server)
        .post('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: 'DAYPASS',
          name: 'Day pass',
          kind: 'WALK_IN',
          priceCentavos: 9000,
          termMonths: 1,
        })
        .expect(400);

      expect((response.body as Envelope<never>).error?.message).toMatch(/termMonths/);
    });

    it('400s a TERM plan with no termMonths', async () => {
      await request(server)
        .post('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code: 'OPEN_ENDED', name: 'Open ended', kind: 'TERM', priceCentavos: 80000 })
        .expect(400);
    });

    it('400s a fractional price — money is integer centavos', async () => {
      await request(server)
        .post('/api/v1/admin/plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: 'HALFPESO',
          name: 'Half',
          kind: 'TERM',
          priceCentavos: 80000.5,
          termMonths: 1,
        })
        .expect(400);
    });
  });

  describe('PATCH /admin/plans/:id (route 8)', () => {
    it('reprices a plan without touching anything already sold', async () => {
      const response = await request(server)
        .patch(`/api/v1/admin/plans/${planIds.MONTHLY}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ priceCentavos: 85000 })
        .expect(200);

      expect((response.body as Envelope<AdminPlanBody>).data?.priceCentavos).toBe(85000);
      const row = await ctx.prisma.plan.findUniqueOrThrow({ where: { code: 'MONTHLY' } });
      expect(row.priceCentavos).toBe(85000);
    });

    it('rejects a code change — the property is not in the DTO at all', async () => {
      await request(server)
        .patch(`/api/v1/admin/plans/${planIds.MONTHLY}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code: 'MONTHLY_V2' })
        .expect(400);
    });

    it('404s PLAN_NOT_FOUND for an unknown id', async () => {
      const response = await request(server)
        .patch('/api/v1/admin/plans/8f14e45f-ceea-4671-a3ab-9e2a5b3f0000')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ priceCentavos: 85000 })
        .expect(404);

      expect((response.body as Envelope<never>).error?.code).toBe('PLAN_NOT_FOUND');
    });

    it('422s PLAN_ARCHIVED rather than silently editing a retired plan', async () => {
      await request(server)
        .post(`/api/v1/admin/plans/${planIds.QUARTERLY}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const response = await request(server)
        .patch(`/api/v1/admin/plans/${planIds.QUARTERLY}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ priceCentavos: 230000 })
        .expect(422);

      expect((response.body as Envelope<never>).error?.code).toBe('PLAN_ARCHIVED');
    });
  });

  describe('POST /admin/plans/:id/archive (route 9)', () => {
    it('retires a plan instead of deleting it', async () => {
      const response = await request(server)
        .post(`/api/v1/admin/plans/${planIds.ANNUAL}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect((response.body as Envelope<AdminPlanBody>).data?.isActive).toBe(false);
      expect(await ctx.prisma.plan.count()).toBe(4);
    });

    it('is idempotent — a second archive returns the same row, not a 409', async () => {
      await request(server)
        .post(`/api/v1/admin/plans/${planIds.ANNUAL}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const again = await request(server)
        .post(`/api/v1/admin/plans/${planIds.ANNUAL}/archive`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect((again.body as Envelope<AdminPlanBody>).data?.isActive).toBe(false);
    });

    it('404s PLAN_NOT_FOUND for an unknown id', async () => {
      const response = await request(server)
        .post('/api/v1/admin/plans/8f14e45f-ceea-4671-a3ab-9e2a5b3f0000/archive')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);

      expect((response.body as Envelope<never>).error?.code).toBe('PLAN_NOT_FOUND');
    });
  });

  describe('the seed is create-only', () => {
    it('re-seeding reverts no price the owner edited', async () => {
      await request(server)
        .patch(`/api/v1/admin/plans/${planIds.MONTHLY}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ priceCentavos: 85000 })
        .expect(200);

      const result = await seedPlans(ctx.prisma);

      expect(result).toEqual({ created: 0, skipped: 4 });
      const row = await ctx.prisma.plan.findUniqueOrThrow({ where: { code: 'MONTHLY' } });
      expect(row.priceCentavos).toBe(85000);
    });

    it('restores a plan the owner deleted outright, without disturbing the rest', async () => {
      await request(server)
        .patch(`/api/v1/admin/plans/${planIds.ANNUAL}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ priceCentavos: 799000 })
        .expect(200);
      await ctx.prisma.plan.delete({ where: { code: 'WALKIN' } });

      const result = await seedPlans(ctx.prisma);

      expect(result).toEqual({ created: 1, skipped: 3 });
      expect(
        (await ctx.prisma.plan.findUniqueOrThrow({ where: { code: 'WALKIN' } })).priceCentavos,
      ).toBe(9000);
      expect(
        (await ctx.prisma.plan.findUniqueOrThrow({ where: { code: 'ANNUAL' } })).priceCentavos,
      ).toBe(799000);
    });
  });
});
