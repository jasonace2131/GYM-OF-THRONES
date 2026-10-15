import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';

jest.setTimeout(120_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface AssignmentView {
  id: string;
  coachId: string;
  memberId: string;
  status: string;
  endedAt: string | null;
}

describe('coach-assignments (e2e)', () => {
  let ctx: TestApp;
  let server: Server;

  let adminToken: string;
  let coachAToken: string;
  let coachBToken: string;
  let coachAId: string;
  let coachBId: string;
  let clientAId: string;
  let clientBId: string;

  let assignmentA: AssignmentView;
  let assignmentB: AssignmentView;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
    await resetDatabase(ctx.prisma);

    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    coachAToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });
    coachBToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_B });
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_B });

    coachAId = await ctx.fixture.userIdFor(FIXTURE_IDS.COACH_A);
    coachBId = await ctx.fixture.userIdFor(FIXTURE_IDS.COACH_B);
    clientAId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);
    clientBId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_B);

    const created = await Promise.all([
      request(server)
        .post('/api/v1/coach-assignments')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ coachId: coachAId, memberId: clientAId }),
      request(server)
        .post('/api/v1/coach-assignments')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ coachId: coachBId, memberId: clientBId }),
    ]);
    assignmentA = (created[0].body as Envelope<AssignmentView>).data as AssignmentView;
    assignmentB = (created[1].body as Envelope<AssignmentView>).data as AssignmentView;
    expect(created[0].status).toBe(201);
    expect(created[1].status).toBe(201);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('1. COACH_A sees the rows of their own assigned member', async () => {
    const res = await request(server)
      .get('/api/v1/coach-assignments')
      .set('Authorization', `Bearer ${coachAToken}`)
      .expect(200);

    const body = res.body as Envelope<{ items: AssignmentView[] }>;
    expect(body.data?.items.map((i) => i.id)).toEqual([assignmentA.id]);
  });

  it("2. COACH_A does not see COACH_B's client in a list", async () => {
    const res = await request(server)
      .get('/api/v1/coach-assignments')
      .set('Authorization', `Bearer ${coachAToken}`)
      .expect(200);

    const body = res.body as Envelope<{ items: AssignmentView[] }>;
    expect(body.data?.items.map((i) => i.id)).not.toContain(assignmentB.id);
  });

  it("3. COACH_A requesting COACH_B's row by id gets 404, not 403", async () => {
    const res = await request(server)
      .get(`/api/v1/coach-assignments/${assignmentB.id}`)
      .set('Authorization', `Bearer ${coachAToken}`)
      .expect(404);

    const body = res.body as Envelope<never>;
    expect(body.error?.code).toBe('COACH_ASSIGNMENT_NOT_FOUND');
  });

  // §11.2 case 4 says "FRONT_DESK at ALL". On the shipped catalogue
  // (server/src/rbac/permission-registry.ts) FRONT_DESK holds no `coach.read`
  // grant at all — ADMIN is the role that holds it at ALL — so ADMIN is what
  // exercises the ALL branch here. Do not add a FRONT_DESK grant to make the
  // sentence literal; the grant table is a product decision.
  it('4. a caller holding coach.read at ALL sees both assignments', async () => {
    const res = await request(server)
      .get('/api/v1/coach-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const body = res.body as Envelope<{ items: AssignmentView[] }>;
    const ids = body.data?.items.map((i) => i.id) ?? [];
    expect(ids).toEqual(expect.arrayContaining([assignmentA.id, assignmentB.id]));
  });

  it('5. widening the grant to ALL flips case 2 with no code change', async () => {
    const permission = await ctx.prisma.permission.findUniqueOrThrow({
      where: { key: 'coach.read' },
    });

    // try/finally so an assertion failure between the widen and the revert
    // cannot leak the widened grant into every later test in this file.
    try {
      await ctx.prisma.rolePermission.update({
        where: { role_permissionId: { role: 'COACH', permissionId: permission.id } },
        data: { scope: 'ALL' },
      });
      // The cache key is `${id}:${role}:${permissionVersion}`, so the bump is
      // what makes the widening visible inside the 60s TTL.
      await ctx.prisma.user.updateMany({
        where: { role: 'COACH' },
        data: { permissionVersion: { increment: 1 } },
      });

      const widened = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });
      const res = await request(server)
        .get('/api/v1/coach-assignments')
        .set('Authorization', `Bearer ${widened}`)
        .expect(200);

      const body = res.body as Envelope<{ items: AssignmentView[] }>;
      expect(body.data?.items.map((i) => i.id)).toEqual(
        expect.arrayContaining([assignmentA.id, assignmentB.id]),
      );
    } finally {
      await ctx.prisma.rolePermission.update({
        where: { role_permissionId: { role: 'COACH', permissionId: permission.id } },
        data: { scope: 'OWN' },
      });
      await ctx.prisma.user.updateMany({
        where: { role: 'COACH' },
        data: { permissionVersion: { increment: 1 } },
      });
    }
  });

  it('rejects self-assignment with 422 COACH_SELF_ASSIGNMENT', async () => {
    const res = await request(server)
      .post('/api/v1/coach-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ coachId: coachAId, memberId: coachAId })
      .expect(422);

    expect((res.body as Envelope<never>).error?.code).toBe('COACH_SELF_ASSIGNMENT');
  });

  it('rejects a non-coach coachId with 422 COACH_NOT_A_COACH', async () => {
    const res = await request(server)
      .post('/api/v1/coach-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ coachId: clientAId, memberId: clientBId })
      .expect(422);

    expect((res.body as Envelope<never>).error?.code).toBe('COACH_NOT_A_COACH');
  });

  it('reassignment soft-ends the incumbent in one transaction', async () => {
    const res = await request(server)
      .post('/api/v1/coach-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ coachId: coachBId, memberId: clientAId })
      .expect(201);

    const fresh = (res.body as Envelope<AssignmentView>).data as AssignmentView;
    expect(fresh.coachId).toBe(coachBId);

    const incumbent = await ctx.prisma.coachAssignment.findUniqueOrThrow({
      where: { id: assignmentA.id },
    });
    expect(incumbent.status).toBe('ENDED');
    expect(incumbent.endedAt).not.toBeNull();
    expect(incumbent.activeMemberId).toBeNull();

    const active = await ctx.prisma.coachAssignment.count({
      where: { memberId: clientAId, status: 'ACTIVE' },
    });
    expect(active).toBe(1);

    // Put clientA back under coachA so ordering between specs cannot matter.
    await request(server)
      .post('/api/v1/coach-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ coachId: coachAId, memberId: clientAId })
      .expect(201);
  });

  it('DELETE is idempotent and returns the ended row both times', async () => {
    const created = await request(server)
      .post('/api/v1/coach-assignments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ coachId: coachAId, memberId: clientBId })
      .expect(201);
    const target = (created.body as Envelope<AssignmentView>).data as AssignmentView;

    const first = await request(server)
      .delete(`/api/v1/coach-assignments/${target.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const second = await request(server)
      .delete(`/api/v1/coach-assignments/${target.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const a = (first.body as Envelope<AssignmentView>).data as AssignmentView;
    const b = (second.body as Envelope<AssignmentView>).data as AssignmentView;
    expect(a.status).toBe('ENDED');
    expect(b.endedAt).toBe(a.endedAt);
  });

  it('a COACH may not create an assignment — coach.assign is not granted', async () => {
    await request(server)
      .post('/api/v1/coach-assignments')
      .set('Authorization', `Bearer ${coachBToken}`)
      .send({ coachId: coachBId, memberId: clientBId })
      .expect(403);
  });
});
