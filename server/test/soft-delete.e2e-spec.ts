import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';

jest.setTimeout(60_000);

describe('soft delete (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
    await resetDatabase(ctx.prisma);
    token = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_DELETED });
    await request(server).get('/api/v1/me').set('Authorization', `Bearer ${token}`).expect(200);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("rejects a soft-deleted user's still-valid token with 403 and does not resurrect the row", async () => {
    const deletedAt = new Date('2026-08-17T00:00:00.000Z');
    await ctx.prisma.user.update({
      where: { supabaseId: FIXTURE_IDS.CLIENT_DELETED },
      data: { deletedAt, lastSeenAt: null },
    });

    const res = await request(server)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect((res.body as { error?: { message: string } }).error?.message).toBe(
      'Account is not active',
    );

    const after = await ctx.prisma.user.findUniqueOrThrow({
      where: { supabaseId: FIXTURE_IDS.CLIENT_DELETED },
    });
    expect(after.deletedAt?.toISOString()).toBe(deletedAt.toISOString());
    // resolve() must not touch a soft-deleted row at all.
    expect(after.lastSeenAt).toBeNull();
  });

  it('gives a soft-deleted user the same message as a suspended one — no enumeration difference', async () => {
    const suspendedToken = await ctx.fixture.tokenFor('CLIENT', {
      supabaseId: FIXTURE_IDS.CLIENT_A,
    });
    await request(server)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${suspendedToken}`)
      .expect(200);
    // All four columns together, never `status` alone: User_suspend_shape
    // (20260827000000_member_suspend_fields) enforces
    // `(status = 'SUSPENDED') = (suspendedAt IS NOT NULL)`, and its two
    // siblings pair suspendedAt with suspendedById and suspendReason. A CHECK
    // constrains every UPDATE regardless of whether it was added NOT VALID, so
    // a bare status write fails outright once that migration is applied.
    // suspendedById is an FK (ON DELETE RESTRICT) — it needs a REAL user row,
    // so the admin fixture is provisioned through the normal path to get one.
    await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    const adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    await ctx.prisma.user.update({
      where: { supabaseId: FIXTURE_IDS.CLIENT_A },
      data: {
        status: 'SUSPENDED',
        suspendedAt: new Date('2026-08-17T00:00:00.000Z'),
        suspendedById: adminId,
        suspendReason: 'Suspended for the enumeration-parity check',
      },
    });

    const suspended = await request(server)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${suspendedToken}`)
      .expect(403);
    const deleted = await request(server)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(suspended.body).toEqual(deleted.body);
  });
});
