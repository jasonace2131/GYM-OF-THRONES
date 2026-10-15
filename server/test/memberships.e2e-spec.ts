import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import {
  addDays,
  civilDateFromPrisma,
  gymToday,
  toDateColumn,
  type CivilDate,
} from '../src/common/time/gym-time';
import { termEndsOn } from '../src/membership/membership-terms';
import { makeMember, openShift, seedPlansForTest } from './support/membership-fixtures';

jest.setTimeout(120_000);

/**
 * The real gym-local day, because these routes call `new Date()` server-side and
 * §5.6 refuses a backdated freeze. One gym, one zone: Asia/Manila is written out
 * rather than read from the environment so a mis-set .env.test cannot silently
 * make "today" mean two different days in one assertion.
 *
 * A run that straddles 00:00 Manila can flake. Accepted: the alternative is
 * injecting a clock into every route.
 */
const TODAY = gymToday(new Date(), 'Asia/Manila');
const ANCHOR = Number(TODAY.slice(8, 10));

let ctx: TestApp;
let server: Server;

beforeAll(async () => {
  ctx = await createTestApp();
  server = ctx.app.getHttpServer() as Server;
});

afterAll(async () => {
  await ctx.close();
});

describe('memberships (e2e)', () => {
  let adminToken: string;
  let deskToken: string;
  let coachAToken: string;
  let clientAToken: string;
  let clientBToken: string;

  let adminId: string;
  let coachAId: string;
  let clientAId: string;
  let clientBId: string;

  let membershipA: string;
  let membershipB: string;

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await seedPlansForTest(ctx.prisma);

    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    deskToken = await ctx.fixture.tokenFor('FRONT_DESK', { supabaseId: FIXTURE_IDS.FRONT_DESK });
    coachAToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });
    clientAToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
    clientBToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_B });

    adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    coachAId = await ctx.fixture.userIdFor(FIXTURE_IDS.COACH_A);
    clientAId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);
    clientBId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_B);

    membershipA = (
      await makeMember(ctx.prisma, {
        userId: clientAId,
        state: 'ACTIVE',
        planCode: 'MONTHLY',
        today: TODAY,
      })
    ).membershipId!;

    membershipB = (
      await makeMember(ctx.prisma, {
        userId: clientBId,
        state: 'STALE_ACTIVE',
        planCode: 'MONTHLY',
        today: TODAY,
      })
    ).membershipId!;

    await ctx.prisma.coachAssignment.create({
      data: {
        coachId: coachAId,
        memberId: clientAId,
        activeMemberId: clientAId,
        assignedById: adminId,
      },
    });
  });

  describe('GET /memberships (route 20) — the scope-leak matrix', () => {
    it('FRONT_DESK at ALL sees both members', async () => {
      const response = await request(server)
        .get('/api/v1/memberships')
        .set('Authorization', `Bearer ${deskToken}`)
        .expect(200);

      expect(response.body.data.total).toBe(2);
      expect(
        response.body.data.items.map((item: { userId: string }) => item.userId).sort(),
      ).toEqual([clientAId, clientBId].sort());
    });

    it('COACH_A at OWN sees only the member assigned to them', async () => {
      const response = await request(server)
        .get('/api/v1/memberships')
        .set('Authorization', `Bearer ${coachAToken}`)
        .expect(200);

      expect(response.body.data.total).toBe(1);
      expect(response.body.data.items[0].userId).toBe(clientAId);
    });

    it('a CLIENT is refused outright — their own data is served by /me/*', async () => {
      await request(server)
        .get('/api/v1/memberships')
        .set('Authorization', `Bearer ${clientAToken}`)
        .expect(403);
    });

    it('projects the door verdict, so the CRM and the desk cannot disagree', async () => {
      const response = await request(server)
        .get('/api/v1/memberships')
        .set('Authorization', `Bearer ${deskToken}`)
        .expect(200);

      const stale = response.body.data.items.find(
        (item: { userId: string }) => item.userId === clientBId,
      );
      // The row still says ACTIVE — the nightly job has not run. The door says
      // no anyway, because endsOn + graceDays says so. That is R1.
      expect(stale.status).toBe('ACTIVE');
      expect(stale.decision).toBe('DENY');
      expect(stale.denialReason).toBe('MEMBERSHIP_EXPIRED');
      expect(stale.daysRemaining).toBe(0);

      const live = response.body.data.items.find(
        (item: { userId: string }) => item.userId === clientAId,
      );
      expect(live.decision).toBe('ALLOW');
      expect(live.allowReason).toBe('MEMBERSHIP_ACTIVE');
    });

    it('filters by status, planCode and expiringWithinDays', async () => {
      const expiring = await request(server)
        .get('/api/v1/memberships?expiringWithinDays=30')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(expiring.body.data.items.map((i: { id: string }) => i.id)).toEqual([membershipA]);

      const byPlan = await request(server)
        .get('/api/v1/memberships?planCode=ANNUAL')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(byPlan.body.data.items).toEqual([]);
    });

    it('searches on the member name and code, not on the membership row', async () => {
      await ctx.prisma.user.update({
        where: { id: clientAId },
        data: { firstName: 'Marisol', memberCode: 'K7QX2M' },
      });

      const byName = await request(server)
        .get('/api/v1/memberships?search=mariso')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(byName.body.data.items.map((i: { id: string }) => i.id)).toEqual([membershipA]);

      const byCode = await request(server)
        .get('/api/v1/memberships?search=K7QX2M')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(byCode.body.data.items.map((i: { id: string }) => i.id)).toEqual([membershipA]);
    });

    it('AND-ing the scope does not widen it when a filter carries its own OR', async () => {
      // `search` builds an OR over the user relation and `scope` builds another
      // over assignment. Spread them together and the coach sees everyone.
      const response = await request(server)
        .get('/api/v1/memberships?search=Fixture')
        .set('Authorization', `Bearer ${coachAToken}`)
        .expect(200);

      expect(
        response.body.data.items.every((i: { userId: string }) => i.userId === clientAId),
      ).toBe(true);
    });
  });

  describe('GET /memberships/:id (route 21)', () => {
    it('404s a membership outside the caller’s scope — never 403', async () => {
      // A 403 would confirm the row exists and turn this into an enumeration
      // oracle for the whole member base.
      const response = await request(server)
        .get(`/api/v1/memberships/${membershipB}`)
        .set('Authorization', `Bearer ${coachAToken}`)
        .expect(404);

      expect(response.body.error.code).toBe('MEMBERSHIP_NOT_FOUND');
    });

    it('404s an id that does not exist, with the same code and status', async () => {
      const response = await request(server)
        .get('/api/v1/memberships/0b000000-0000-4000-8000-00000000ff01')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);

      expect(response.body.error.code).toBe('MEMBERSHIP_NOT_FOUND');
    });

    it('gates `payments` on resolved payment.read, not on the caller’s role', async () => {
      await openShift(ctx.prisma, adminId, TODAY);
      await ctx.prisma.payment.create({
        data: {
          userId: clientAId,
          membershipId: membershipA,
          planId: (await ctx.prisma.plan.findUniqueOrThrow({ where: { code: 'MONTHLY' } })).id,
          purpose: 'MEMBERSHIP',
          planCode: 'MONTHLY',
          planName: 'Monthly',
          grossCentavos: 80000,
          vatBaseCentavos: 80000,
          netCentavos: 80000,
          termMonths: 1,
          termStartsOn: toDateColumn(TODAY),
          termEndsOn: toDateColumn(TODAY),
          method: 'CASH',
          receivedAt: new Date(),
          businessDate: toDateColumn(TODAY),
          shiftId: (await ctx.prisma.shift.findFirstOrThrow()).id,
          recordedById: adminId,
          idempotencyKey: 'fixture-membership-a-payment',
          idempotencyHash: 'f'.repeat(64),
        },
      });

      const desk = await request(server)
        .get(`/api/v1/memberships/${membershipA}`)
        .set('Authorization', `Bearer ${deskToken}`)
        .expect(200);
      expect(desk.body.data.payments).toHaveLength(1);
      expect(desk.body.data.payments[0].netCentavos).toBe(80000);

      // COACH holds membership.read at OWN and no payment.read at all.
      const coach = await request(server)
        .get(`/api/v1/memberships/${membershipA}`)
        .set('Authorization', `Bearer ${coachAToken}`)
        .expect(200);
      expect(coach.body.data.payments).toBeUndefined();
    });

    it('carries the verdict, the running hold and the event timeline', async () => {
      const frozen = await makeMember(ctx.prisma, {
        state: 'FROZEN',
        planCode: 'QUARTERLY',
        today: TODAY,
      });

      const response = await request(server)
        .get(`/api/v1/memberships/${frozen.membershipId!}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.data.status).toBe('FROZEN');
      expect(response.body.data.verdict.decision).toBe('DENY');
      expect(response.body.data.verdict.denialReason).toBe('MEMBERSHIP_FROZEN');
      expect(response.body.data.verdict.offer).toBe('OVERRIDE');
      expect(response.body.data.hold.daysRequested).toBe(14);
      expect(response.body.data.hold.status).toBe('ACTIVE');
      expect(response.body.data.events).toEqual([]);
      expect(JSON.stringify(response.body)).not.toMatch(/₱|PHP/);
    });
  });

  describe('/me routes (10, 11, 12)', () => {
    it('GET /me/membership never 404s: no membership is a renderable state', async () => {
      const none = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_DELETED });
      await ctx.prisma.user.update({
        where: { supabaseId: FIXTURE_IDS.CLIENT_DELETED },
        data: { deletedAt: null },
      });

      const response = await request(server)
        .get('/api/v1/me/membership')
        .set('Authorization', `Bearer ${none}`)
        .expect(200);

      expect(response.body.data.membership).toBeNull();
      expect(response.body.data.verdict.decision).toBe('DENY');
      expect(response.body.data.verdict.denialReason).toBe('NO_MEMBERSHIP');
      expect(response.body.data.verdict.offer).toBe('RENEW');
    });

    it('GET /me/membership returns the caller’s own membership and verdict', async () => {
      const response = await request(server)
        .get('/api/v1/me/membership')
        .set('Authorization', `Bearer ${clientAToken}`)
        .expect(200);

      expect(response.body.data.membership.id).toBe(membershipA);
      expect(response.body.data.membership.planCode).toBe('MONTHLY');
      expect(response.body.data.membership.planPriceCentavos).toBe(80000);
      expect(response.body.data.verdict.decision).toBe('ALLOW');
      // The member's own screen shows no staff attribution.
      expect(response.body.data.membership.events).toEqual([]);
      expect(response.body.data.membership.payments).toBeUndefined();
    });

    it('GET /me/membership needs no permission key and cannot reach anyone else', async () => {
      const response = await request(server)
        .get('/api/v1/me/membership')
        .set('Authorization', `Bearer ${clientBToken}`)
        .expect(200);

      expect(response.body.data.membership.id).toBe(membershipB);
      expect(response.body.data.verdict.decision).toBe('DENY');
    });

    it('GET /me/overview carries the member code, the verdict and the last payment', async () => {
      const response = await request(server)
        .get('/api/v1/me/overview')
        .set('Authorization', `Bearer ${clientAToken}`)
        .expect(200);

      expect(response.body.data.userId).toBe(clientAId);
      expect(response.body.data.firstName).toBe('CLIENT');
      expect(response.body.data.verdict.message).toContain('Monthly');
      expect(response.body.data.lastPayment).toBeNull();
      expect(response.body.data.guestPassesRemaining).toBe(0);
    });

    it('GET /me/payments returns only the caller’s own rows', async () => {
      await openShift(ctx.prisma, adminId, TODAY);
      const shiftId = (await ctx.prisma.shift.findFirstOrThrow()).id;
      const planId = (await ctx.prisma.plan.findUniqueOrThrow({ where: { code: 'WALKIN' } })).id;

      for (const [userId, key] of [
        [clientAId, 'fixture-me-a'],
        [clientBId, 'fixture-me-b'],
      ] as const) {
        await ctx.prisma.payment.create({
          data: {
            userId,
            planId,
            purpose: 'WALK_IN',
            planCode: 'WALKIN',
            planName: 'Walk-in',
            grossCentavos: 9000,
            vatBaseCentavos: 9000,
            netCentavos: 9000,
            method: 'CASH',
            receivedAt: new Date(),
            businessDate: toDateColumn(TODAY),
            shiftId,
            recordedById: adminId,
            idempotencyKey: key,
            idempotencyHash: 'a'.repeat(64),
          },
        });
      }

      const response = await request(server)
        .get('/api/v1/me/payments')
        .set('Authorization', `Bearer ${clientAToken}`)
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.items[0].userId).toBe(clientAId);
      expect(response.body.data.items[0].netCentavos).toBe(9000);
      expect(response.body.data.totalCentavos).toBe(9000);
    });
  });
});

describe('sell and renew (routes 22, 23)', () => {
  let adminToken: string;
  let adminId: string;
  let shiftId: string;

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    // Plan ids are unused here (every request addresses a plan by `code`),
    // but seeding must still run: resetDatabase() truncates Plan too.
    await seedPlansForTest(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    shiftId = await openShift(ctx.prisma, adminId, TODAY);
  });

  it('sells a first term, allocating the memberCode lazily inside the transaction', async () => {
    const member = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });

    const response = await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000001')
      .send({ userId: member.userId, planCode: 'MONTHLY', method: 'CASH' })
      .expect(201);

    expect(response.body.data.status).toBe('ACTIVE');

    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: member.userId },
      include: { membership: true },
    });
    expect(user.memberCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);

    const membership = user.membership!;
    expect(civilDateFromPrisma(membership.startsOn)).toBe(TODAY);
    expect(civilDateFromPrisma(membership.endsOn)).toBe(termEndsOn(ANCHOR, TODAY, 1));
    expect(civilDateFromPrisma(membership.joinedOn)).toBe(TODAY);
    expect(membership.billingAnchorDay).toBe(ANCHOR);
    expect(membership.planPriceCentavos).toBe(80000);
    expect(membership.graceDays).toBe(3);
    expect(membership.graceAdmissionsThisTerm).toBe(0);
    expect(membership.freezesUsedThisTerm).toBe(0);

    const payment = await ctx.prisma.payment.findFirstOrThrow({
      where: { membershipId: membership.id },
    });
    expect(payment.purpose).toBe('MEMBERSHIP');
    expect(payment.grossCentavos).toBe(80000);
    expect(payment.netCentavos).toBe(80000);
    expect(payment.termMonths).toBe(1);
    expect(civilDateFromPrisma(payment.termStartsOn!)).toBe(TODAY);
    expect(civilDateFromPrisma(payment.termEndsOn!)).toBe(termEndsOn(ANCHOR, TODAY, 1));
    expect(payment.shiftId).toBe(shiftId);
    expect(payment.idempotencyKey).toBe('7c1b0a10-0000-4000-8000-000000000001');

    const events = await ctx.prisma.membershipEvent.findMany({
      where: { membershipId: membership.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'PURCHASED',
      fromStatus: null,
      toStatus: 'ACTIVE',
      previousEndsOn: null,
      newEndsOn: null,
      actorId: adminId,
      paymentId: payment.id,
    });
  });

  it('replays a repeated Idempotency-Key as 200 and writes exactly one Payment', async () => {
    const member = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });
    const body = { userId: member.userId, planCode: 'QUARTERLY', method: 'CASH' };

    await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000002')
      .send(body)
      .expect(201);

    const replay = await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000002')
      .send(body)
      .expect(200);

    expect(replay.body.success).toBe(true);
    expect(await ctx.prisma.payment.count()).toBe(1);
    expect(await ctx.prisma.membershipEvent.count()).toBe(1);
  });

  it('renews before expiry from endsOn + 1, leaving the anchor alone', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    const previousEndsOn = civilDateFromPrisma(before.endsOn);

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/renew`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000003')
      .send({ planCode: 'MONTHLY', method: 'CASH' })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
    expect(civilDateFromPrisma(after.startsOn)).toBe(addDays(previousEndsOn, 1));
    expect(civilDateFromPrisma(after.endsOn)).toBe(
      termEndsOn(before.billingAnchorDay, addDays(previousEndsOn, 1), 1),
    );
    expect(after.billingAnchorDay).toBe(before.billingAnchorDay);
    expect(civilDateFromPrisma(after.joinedOn)).toBe(civilDateFromPrisma(before.joinedOn));

    const event = await ctx.prisma.membershipEvent.findFirstOrThrow({
      where: { membershipId: member.membershipId!, type: 'RENEWED' },
    });
    expect(civilDateFromPrisma(event.previousEndsOn!)).toBe(previousEndsOn);
    expect(civilDateFromPrisma(event.newEndsOn!)).toBe(civilDateFromPrisma(after.endsOn));
  });

  it('renews inside grace by backdating to endsOn + 1 and keeps full grace', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'IN_GRACE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/renew`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000004')
      .send({ planCode: 'MONTHLY', method: 'CASH' })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
    expect(civilDateFromPrisma(after.startsOn)).toBe(TODAY);
    expect(after.billingAnchorDay).toBe(before.billingAnchorDay);
    // First late settlement in this membership's history: grace is untouched.
    expect(after.graceAdmissionsThisTerm).toBe(0);

    const event = await ctx.prisma.membershipEvent.findFirstOrThrow({
      where: { membershipId: member.membershipId!, type: 'RENEWED' },
    });
    expect(event.reason).toBe('in grace');
  });

  it('kills the second term grace when the previous term was also settled late', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'IN_GRACE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    // §5.4.3: the previous RENEWED event's previousEndsOn was already behind the
    // gym-local day it took effect on — that term ran out and was paid in grace.
    await ctx.prisma.membershipEvent.create({
      data: {
        membershipId: member.membershipId!,
        type: 'RENEWED',
        fromStatus: 'EXPIRED',
        toStatus: 'ACTIVE',
        previousEndsOn: toDateColumn(addDays(TODAY, -40)),
        newEndsOn: toDateColumn(addDays(TODAY, -10)),
        reason: 'in grace',
        actorId: adminId,
        effectiveAt: new Date(`${addDays(TODAY, -38)}T02:00:00.000Z`),
      },
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/renew`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000005')
      .send({ planCode: 'MONTHLY', method: 'CASH' })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.graceAdmissionsThisTerm).toBe(3);
  });

  it('reactivates past grace from today, re-anchoring, as REACTIVATED not RENEWED', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'EXPIRED_PAST_GRACE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/renew`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000006')
      .send({ planCode: 'MONTHLY', method: 'CASH' })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
    expect(civilDateFromPrisma(after.startsOn)).toBe(TODAY);
    expect(civilDateFromPrisma(after.endsOn)).toBe(termEndsOn(ANCHOR, TODAY, 1));
    expect(after.billingAnchorDay).toBe(ANCHOR);

    expect(
      await ctx.prisma.membershipEvent.count({
        where: { membershipId: member.membershipId!, type: 'REACTIVATED' },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.membershipEvent.count({
        where: { membershipId: member.membershipId!, type: 'RENEWED' },
      }),
    ).toBe(0);
  });

  it('reactivates a CANCELLED membership and clears cancelledOn', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'CANCELLED',
      planCode: 'QUARTERLY',
      today: TODAY,
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/renew`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000007')
      .send({ planCode: 'QUARTERLY', method: 'CASH' })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
    expect(after.cancelledOn).toBeNull();
    expect(after.cancelRequestedOn).toBeNull();
    expect(civilDateFromPrisma(after.startsOn)).toBe(TODAY);
    expect(after.billingAnchorDay).toBe(ANCHOR);
  });

  it('refuses to renew a FROZEN membership with 422 MEMBERSHIP_NOT_ACTIVE', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'FROZEN',
      planCode: 'QUARTERLY',
      today: TODAY,
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/renew`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000008')
      .send({ planCode: 'QUARTERLY', method: 'CASH' })
      .expect(422);

    expect(response.body.error.code).toBe('MEMBERSHIP_NOT_ACTIVE');
    expect(await ctx.prisma.payment.count()).toBe(0);
  });

  it('computes the statutory senior discount and records the OSCA number on the person', async () => {
    const member = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });

    await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-000000000009')
      .send({
        userId: member.userId,
        planCode: 'MONTHLY',
        method: 'CASH',
        discountType: 'SENIOR',
        statutoryIdNo: 'OSCA-2019-004412',
      })
      .expect(201);

    // GYM_VAT_REGISTERED is false in .env.test, so vatBase is the gross.
    const payment = await ctx.prisma.payment.findFirstOrThrow({});
    expect(payment.grossCentavos).toBe(80000);
    expect(payment.vatBaseCentavos).toBe(80000);
    expect(payment.discountCentavos).toBe(16000);
    expect(payment.netCentavos).toBe(64000);
    expect(payment.vatExempt).toBe(false);
    expect(payment.statutoryIdNo).toBe('OSCA-2019-004412');

    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: member.userId } });
    expect(user.seniorPwdIdNo).toBe('OSCA-2019-004412');
  });

  it('refuses a SENIOR sale with no ID anywhere — 422 STATUTORY_ID_REQUIRED', async () => {
    const member = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });

    const response = await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-00000000000a')
      .send({ userId: member.userId, planCode: 'MONTHLY', method: 'CASH', discountType: 'SENIOR' })
      .expect(422);

    expect(response.body.error.code).toBe('STATUTORY_ID_REQUIRED');
    expect(await ctx.prisma.membership.count()).toBe(0);
  });

  it('refuses a sale with no open drawer — 422 SHIFT_NOT_OPEN, and nothing is written', async () => {
    const member = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });
    await ctx.prisma.shift.deleteMany({});

    const response = await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-00000000000b')
      .send({ userId: member.userId, planCode: 'MONTHLY', method: 'CASH' })
      .expect(422);

    expect(response.body.error.code).toBe('SHIFT_NOT_OPEN');
    expect(await ctx.prisma.membership.count()).toBe(0);
    expect(await ctx.prisma.payment.count()).toBe(0);
  });

  it('refuses a second POST /memberships for a member who already has one', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const response = await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-00000000000c')
      .send({ userId: member.userId, planCode: 'MONTHLY', method: 'CASH' })
      .expect(409);

    expect(response.body.error.code).toBe('MEMBER_ALREADY_IMPORTED');
    expect(await ctx.prisma.membership.count()).toBe(1);
  });

  it('refuses the walk-in price as a membership plan', async () => {
    const member = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });

    const response = await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-00000000000d')
      .send({ userId: member.userId, planCode: 'WALKIN', method: 'CASH' })
      .expect(404);

    expect(response.body.error.code).toBe('PLAN_NOT_FOUND');
  });

  it('refuses a COACH: selling is FRONT_DESK and ADMIN only', async () => {
    const member = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });
    const coachToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });

    await request(server)
      .post('/api/v1/memberships')
      .set('Authorization', `Bearer ${coachToken}`)
      .set('Idempotency-Key', '7c1b0a10-0000-4000-8000-00000000000e')
      .send({ userId: member.userId, planCode: 'MONTHLY', method: 'CASH' })
      .expect(403);
  });
});

describe('freeze / unfreeze (routes 26, 27)', () => {
  let adminToken: string;
  let adminId: string;

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await seedPlansForTest(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    await openShift(ctx.prisma, adminId, TODAY);
  });

  it('applies a same-day freeze inside one transaction: status FROZEN and endsOn extended', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ startsOn: TODAY, endsOn: addDays(TODAY, 13), reason: 'travelling to Cebu' })
      .expect(200);

    expect(response.body.data.status).toBe('FROZEN');

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(civilDateFromPrisma(after.endsOn)).toBe(addDays(civilDateFromPrisma(before.endsOn), 14));
    expect(after.freezesUsedThisTerm).toBe(1);

    const hold = await ctx.prisma.membershipHold.findFirstOrThrow({
      where: { membershipId: member.membershipId! },
    });
    expect(hold.status).toBe('ACTIVE');
    expect(hold.daysApplied).toBe(14);
    expect(hold.activeMembershipId).toBe(member.membershipId);

    const fee = await ctx.prisma.payment.findFirstOrThrow({
      where: { membershipId: member.membershipId!, purpose: 'FREEZE_FEE' },
    });
    expect(fee.netCentavos).toBe(10000);

    const events = await ctx.prisma.membershipEvent.findMany({
      where: { membershipId: member.membershipId!, type: 'HOLD_APPLIED' },
    });
    expect(events).toHaveLength(1);
  });

  it('leaves a future-dated hold SCHEDULED with no status change and no arithmetic', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'ANNUAL',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ startsOn: addDays(TODAY, 10), endsOn: addDays(TODAY, 24), reason: 'work abroad' })
      .expect(200);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
    expect(civilDateFromPrisma(after.endsOn)).toBe(civilDateFromPrisma(before.endsOn));

    const hold = await ctx.prisma.membershipHold.findFirstOrThrow({
      where: { membershipId: member.membershipId! },
    });
    expect(hold.status).toBe('SCHEDULED');
    expect(hold.daysApplied).toBe(0);
    expect(hold.activeMembershipId).toBeNull();
  });

  it('refuses a MONTHLY membership with 422 PLAN_NOT_FREEZABLE', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ startsOn: TODAY, endsOn: addDays(TODAY, 13), reason: 'travelling' })
      .expect(422);

    expect(response.body.error.code).toBe('PLAN_NOT_FREEZABLE');
  });

  it('waives the fee for a medical freeze', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        startsOn: TODAY,
        endsOn: addDays(TODAY, 20),
        reason: 'medical — knee surgery',
        feeWaived: true,
      })
      .expect(200);

    const fees = await ctx.prisma.payment.findMany({ where: { purpose: 'FREEZE_FEE' } });
    expect(fees).toHaveLength(0);
  });

  it('claws back exactly the unused days on an early release', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ startsOn: TODAY, endsOn: addDays(TODAY, 29), reason: 'travelling' })
      .expect(200);

    // Released on day one: 29 unused days remain (today..endsOn), 1 day consumed.
    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/unfreeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'came home early' })
      .expect(200);

    expect(response.body.data.status).toBe('ACTIVE');

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(civilDateFromPrisma(after.endsOn)).toBe(addDays(civilDateFromPrisma(before.endsOn), 1));

    const hold = await ctx.prisma.membershipHold.findFirstOrThrow({
      where: { membershipId: member.membershipId! },
    });
    expect(hold.status).toBe('COMPLETED');
    expect(hold.daysApplied).toBe(1);
    expect(hold.activeMembershipId).toBeNull();
    expect(hold.releasedAt).not.toBeNull();
  });

  it('refuses a second freeze while one is running', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'FROZEN',
      planCode: 'QUARTERLY',
      today: TODAY,
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/freeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ startsOn: TODAY, endsOn: addDays(TODAY, 13), reason: 'again' })
      .expect(422);

    expect(response.body.error.code).toBe('MEMBERSHIP_NOT_ACTIVE');
  });

  it('refuses unfreeze on a membership that is not frozen', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/unfreeze`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(422);

    expect(response.body.error.code).toBe('MEMBERSHIP_NOT_FROZEN');
  });

  it('refuses FRONT_DESK: the "no" belongs to the owner, not the desk', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const deskToken = await ctx.fixture.tokenFor('FRONT_DESK', {
      supabaseId: FIXTURE_IDS.FRONT_DESK,
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/freeze`)
      .set('Authorization', `Bearer ${deskToken}`)
      .send({ startsOn: TODAY, endsOn: addDays(TODAY, 13), reason: 'travelling' })
      .expect(403);
  });
});

describe('cancellation, comp days and correction (routes 24, 25, 28, 29, 30)', () => {
  let adminToken: string;
  let adminId: string;

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await seedPlansForTest(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    await openShift(ctx.prisma, adminId, TODAY);
  });

  it('records notice without ending the term, and a repeat notice writes no second event', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel-request`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'moving to Cebu for work' })
      .expect(201);

    expect(response.body.data.status).toBe('ACTIVE');

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
    expect(civilDateFromPrisma(after.cancelRequestedOn!)).toBe(TODAY);
    expect(after.cancelledOn).toBeNull();
    // Notice given, term honoured to the end.
    expect(civilDateFromPrisma(after.endsOn)).toBe(civilDateFromPrisma(before.endsOn));

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel-request`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'saying it twice' })
      .expect(201);

    expect(
      await ctx.prisma.membershipEvent.count({
        where: { membershipId: member.membershipId!, type: 'CANCELLATION_REQUESTED' },
      }),
    ).toBe(1);
  });

  it('withdraws notice, and refuses a withdrawal when none was given', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const empty = await request(server)
      .delete(`/api/v1/memberships/${member.membershipId!}/cancel-request`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(422);
    expect(empty.body.error.code).toBe('MEMBERSHIP_INVALID_TRANSITION');

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel-request`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'thinking about it' })
      .expect(201);

    await request(server)
      .delete(`/api/v1/memberships/${member.membershipId!}/cancel-request`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.cancelRequestedOn).toBeNull();
    expect(
      await ctx.prisma.membershipEvent.count({
        where: { membershipId: member.membershipId!, type: 'CANCELLATION_WITHDRAWN' },
      }),
    ).toBe(1);
  });

  it('terminates a membership: cancelledOn is today, endsOn is untouched history', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, reason: 'member moved abroad permanently' })
      .expect(201);

    expect(response.body.data.status).toBe('CANCELLED');

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('CANCELLED');
    expect(civilDateFromPrisma(after.cancelledOn!)).toBe(TODAY);
    expect(civilDateFromPrisma(after.endsOn)).toBe(civilDateFromPrisma(before.endsOn));

    const events = await ctx.prisma.membershipEvent.findMany({
      where: { membershipId: member.membershipId!, type: 'CANCELLED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromStatus: 'ACTIVE',
      toStatus: 'CANCELLED',
      reason: 'member moved abroad permanently',
      actorId: adminId,
    });
  });

  it('refuses an unconfirmed termination with 400 CONFIRMATION_REQUIRED', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: false, reason: 'not really sure' })
      .expect(400);

    expect(response.body.error.code).toBe('CONFIRMATION_REQUIRED');
    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
  });

  it('refuses a second termination with 422 MEMBERSHIP_ALREADY_CANCELLED', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'CANCELLED',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, reason: 'terminating it again' })
      .expect(422);

    expect(response.body.error.code).toBe('MEMBERSHIP_ALREADY_CANCELLED');
  });

  it('claws back the running freeze before terminating (row 10): HOLD_RELEASED then CANCELLED', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'FROZEN',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, reason: 'terminated during a freeze' })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('CANCELLED');
    expect(civilDateFromPrisma(after.cancelledOn!)).toBe(TODAY);
    // The fixture hold runs today..today+13 with 14 days already applied.
    // Released on day one: 13 unused days come back off.
    expect(civilDateFromPrisma(after.endsOn)).toBe(
      addDays(civilDateFromPrisma(before.endsOn), -13),
    );

    const hold = await ctx.prisma.membershipHold.findFirstOrThrow({
      where: { membershipId: member.membershipId! },
    });
    expect(hold.status).toBe('COMPLETED');
    expect(hold.daysApplied).toBe(1);
    expect(hold.activeMembershipId).toBeNull();

    const types = (
      await ctx.prisma.membershipEvent.findMany({
        where: { membershipId: member.membershipId! },
        orderBy: { createdAt: 'asc' },
        select: { type: true },
      })
    ).map((event) => event.type);
    expect(types).toEqual(['HOLD_RELEASED', 'CANCELLED']);
  });

  it('adds comp days to an EXPIRED membership without touching the status', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'EXPIRED_PAST_GRACE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/adjust-term`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, days: 5, reason: 'goodwill — aircon was out all week' })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('EXPIRED');
    expect(civilDateFromPrisma(after.endsOn)).toBe(addDays(civilDateFromPrisma(before.endsOn), 5));

    const event = await ctx.prisma.membershipEvent.findFirstOrThrow({
      where: { membershipId: member.membershipId!, type: 'ADJUSTED' },
    });
    expect(event.fromStatus).toBe('EXPIRED');
    expect(event.toStatus).toBe('EXPIRED');
    expect(event.reason).toBe('goodwill — aircon was out all week');
    expect(civilDateFromPrisma(event.previousEndsOn!)).toBe(civilDateFromPrisma(before.endsOn));
    expect(civilDateFromPrisma(event.newEndsOn!)).toBe(civilDateFromPrisma(after.endsOn));
    expect(event.batchRef).toBeNull();
  });

  it('refuses comp days on a CANCELLED membership with 422 MEMBERSHIP_INVALID_TRANSITION', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'CANCELLED',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const response = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/adjust-term`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, days: 3, reason: 'they asked nicely' })
      .expect(422);

    expect(response.body.error.code).toBe('MEMBERSHIP_INVALID_TRANSITION');
  });

  it('refuses comp days outside 1..60 at the pipe', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/adjust-term`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, days: 61, reason: 'far too generous' })
      .expect(400);

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/adjust-term`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, days: -3, reason: 'taking days back' })
      .expect(400);
  });

  it('corrects a data error, bypassing the transition table the other routes obey', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'EXPIRED_PAST_GRACE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });

    // EXPIRED -> FROZEN is refused by assertTransition on every other route.
    // membership.status.correct is the one documented bypass, and it is the
    // reason this test exists.
    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/correct`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        confirm: true,
        status: 'FROZEN',
        endsOn: addDays(TODAY, 20),
        reason: 'keyed against the wrong member on 14 Aug',
      })
      .expect(201);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('FROZEN');
    expect(civilDateFromPrisma(after.endsOn)).toBe(addDays(TODAY, 20));
    expect(after.cancelledOn).toBeNull();

    const event = await ctx.prisma.membershipEvent.findFirstOrThrow({
      where: { membershipId: member.membershipId!, type: 'STATUS_CORRECTED' },
    });
    expect(event.fromStatus).toBe('EXPIRED');
    expect(event.toStatus).toBe('FROZEN');
    expect(event.reason).toBe('keyed against the wrong member on 14 Aug');
    expect(civilDateFromPrisma(event.previousEndsOn!)).toBe(civilDateFromPrisma(before.endsOn));
    expect(civilDateFromPrisma(event.newEndsOn!)).toBe(addDays(TODAY, 20));
  });

  it('keeps cancelledOn biconditional with the status on both directions of a correction', async () => {
    const cancelled = await makeMember(ctx.prisma, {
      state: 'CANCELLED',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    await request(server)
      .post(`/api/v1/memberships/${cancelled.membershipId!}/correct`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, status: 'ACTIVE', reason: 'cancelled the wrong member' })
      .expect(201);

    const revived = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: cancelled.membershipId! },
    });
    expect(revived.status).toBe('ACTIVE');
    expect(revived.cancelledOn).toBeNull();

    const active = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    await request(server)
      .post(`/api/v1/memberships/${active.membershipId!}/correct`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, status: 'CANCELLED', reason: 'should have been terminated in July' })
      .expect(201);

    const terminated = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: active.membershipId! },
    });
    expect(terminated.status).toBe('CANCELLED');
    expect(civilDateFromPrisma(terminated.cancelledOn!)).toBe(TODAY);
  });

  it('refuses a correction that changes nothing, and one that inverts the term', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const empty = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/correct`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, reason: 'no field supplied' })
      .expect(422);
    expect(empty.body.error.code).toBe('MEMBERSHIP_STATE_INVALID');

    const inverted = await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/correct`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        confirm: true,
        startsOn: addDays(TODAY, 5),
        endsOn: addDays(TODAY, 1),
        reason: 'endsOn before startsOn',
      })
      .expect(422);
    expect(inverted.body.error.code).toBe('MEMBERSHIP_STATE_INVALID');
  });

  it('refuses FRONT_DESK on every dangerous route, and admits it on notice', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    const deskToken = await ctx.fixture.tokenFor('FRONT_DESK', {
      supabaseId: FIXTURE_IDS.FRONT_DESK,
    });

    // membership.cancel.request IS granted to the desk — taking notice is
    // counter work, and the portal promises no lock-in.
    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel-request`)
      .set('Authorization', `Bearer ${deskToken}`)
      .send({ reason: 'member gave notice at the counter' })
      .expect(201);

    for (const [path, body] of [
      ['cancel', { confirm: true, reason: 'terminating now' }],
      ['adjust-term', { confirm: true, days: 3, reason: 'goodwill days' }],
      ['correct', { confirm: true, status: 'EXPIRED', reason: 'fixing a mistake' }],
    ] as const) {
      await request(server)
        .post(`/api/v1/memberships/${member.membershipId!}/${path}`)
        .set('Authorization', `Bearer ${deskToken}`)
        .send(body)
        .expect(403);
    }
  });

  it('404s on a membership that does not exist, never 403', async () => {
    const response = await request(server)
      .post('/api/v1/memberships/00000000-0000-4000-8000-000000000000/cancel')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, reason: 'nothing to terminate' })
      .expect(404);

    expect(response.body.error.code).toBe('MEMBERSHIP_NOT_FOUND');
  });

  it('the append-only trigger rejects an UPDATE and a DELETE on a written event', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    await request(server)
      .post(`/api/v1/memberships/${member.membershipId!}/cancel-request`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'proving the trigger rejects a rewrite' })
      .expect(201);

    const event = await ctx.prisma.membershipEvent.findFirstOrThrow({
      where: { membershipId: member.membershipId!, type: 'CANCELLATION_REQUESTED' },
    });

    await expect(
      ctx.prisma
        .$executeRaw`UPDATE "MembershipEvent" SET reason = 'rewritten' WHERE id = ${event.id}::uuid`,
    ).rejects.toThrow();

    await expect(
      ctx.prisma.$executeRaw`DELETE FROM "MembershipEvent" WHERE id = ${event.id}::uuid`,
    ).rejects.toThrow();

    // Unchanged: the trigger fired BEFORE the write, not after a partial one.
    const stillThere = await ctx.prisma.membershipEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(stillThere.reason).toBe('proving the trigger rejects a rewrite');
  });
});

describe('admin import / extend (routes 31, 32)', () => {
  const ROWS = [
    {
      email: 'juan.delacruz@example.ph',
      phone: '09171234567',
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      planCode: 'MONTHLY',
      startsOn: '2026-08-01',
      endsOn: '2026-08-31',
      joinedOn: '2024-03-15',
    },
    {
      phone: '09189876543',
      firstName: 'Maria',
      lastName: 'Santos',
      planCode: 'QUARTERLY',
      startsOn: '2026-07-15',
      endsOn: '2026-10-14',
      joinedOn: '2025-01-20',
    },
  ];

  let adminToken: string;
  let adminId: string;

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await seedPlansForTest(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
  });

  it('creates a member, a memberCode and a membership with NO payment row', async () => {
    const response = await request(server)
      .post('/api/v1/admin/memberships/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '3f3d1a2c-0f0a-4a8e-9d31-000000000101')
      .send({ confirm: true, rows: ROWS })
      .expect(201);

    expect(response.body.data).toMatchObject({ created: 2, skipped: 0, errors: [] });

    const juan = await ctx.prisma.user.findUniqueOrThrow({
      where: { email: 'juan.delacruz@example.ph' },
      include: { membership: true },
    });
    expect(juan.memberCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(juan.phone).toBe('09171234567');
    expect(civilDateFromPrisma(juan.membership!.endsOn)).toBe('2026-08-31');
    expect(juan.membership!.billingAnchorDay).toBe(1);
    expect(civilDateFromPrisma(juan.membership!.joinedOn)).toBe('2024-03-15');

    expect(await ctx.prisma.payment.count()).toBe(0);

    const events = await ctx.prisma.membershipEvent.findMany({ where: { type: 'IMPORTED' } });
    expect(events).toHaveLength(2);
    expect(events[0].actorId).toBe(adminId);
  });

  it('is idempotent: re-importing the same payload creates nothing and writes no second event', async () => {
    await request(server)
      .post('/api/v1/admin/memberships/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '3f3d1a2c-0f0a-4a8e-9d31-000000000102')
      .send({ confirm: true, rows: ROWS })
      .expect(201);

    const replay = await request(server)
      .post('/api/v1/admin/memberships/import')
      .set('Authorization', `Bearer ${adminToken}`)
      // A DIFFERENT key, so this is a genuine second request, not a replay.
      .set('Idempotency-Key', '3f3d1a2c-0f0a-4a8e-9d31-000000000103')
      .send({ confirm: true, rows: ROWS })
      .expect(201);

    expect(replay.body.data).toMatchObject({ created: 0, skipped: 2 });
    expect(await ctx.prisma.membership.count()).toBe(2);
    expect(await ctx.prisma.membershipEvent.count({ where: { type: 'IMPORTED' } })).toBe(2);
  });

  it('reports a row that identifies nobody without failing the batch', async () => {
    const response = await request(server)
      .post('/api/v1/admin/memberships/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '3f3d1a2c-0f0a-4a8e-9d31-000000000104')
      .send({
        confirm: true,
        rows: [
          ROWS[0],
          {
            firstName: 'Ghost',
            lastName: 'Row',
            planCode: 'MONTHLY',
            startsOn: '2026-08-01',
            endsOn: '2026-08-31',
            joinedOn: '2026-08-01',
          },
        ],
      })
      .expect(201);

    expect(response.body.data.created).toBe(1);
    expect(response.body.data.errors).toEqual([
      { row: 2, email: null, phone: null, code: 'MEMBER_NOT_FOUND', message: expect.any(String) },
    ]);
  });

  it('refuses an unconfirmed import with 400 CONFIRMATION_REQUIRED', async () => {
    const response = await request(server)
      .post('/api/v1/admin/memberships/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '3f3d1a2c-0f0a-4a8e-9d31-000000000105')
      .send({ confirm: false, rows: ROWS })
      .expect(400);

    expect(response.body.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('extends every ACTIVE and FROZEN membership once per batchRef', async () => {
    const active = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    const frozen = await makeMember(ctx.prisma, {
      state: 'FROZEN',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const expired = await makeMember(ctx.prisma, {
      state: 'EXPIRED_PAST_GRACE',
      planCode: 'MONTHLY',
      today: TODAY,
    });

    const before = await ctx.prisma.membership.findMany({ orderBy: { createdAt: 'asc' } });
    const body = {
      confirm: true,
      days: 3,
      reason: 'Typhoon Egay closure',
      batchRef: 'closure-2026-08-19',
    };

    const first = await request(server)
      .post('/api/v1/admin/memberships/extend')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '3f3d1a2c-0f0a-4a8e-9d31-000000000201')
      .send(body)
      .expect(201);
    expect(first.body.data).toEqual({ affected: 2 });

    const second = await request(server)
      .post('/api/v1/admin/memberships/extend')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', '3f3d1a2c-0f0a-4a8e-9d31-000000000202')
      .send(body)
      .expect(201);
    expect(second.body.data).toEqual({ affected: 0 });

    const after = await ctx.prisma.membership.findMany({ orderBy: { createdAt: 'asc' } });
    const endsOnOf = (rows: typeof after, id: string): CivilDate =>
      civilDateFromPrisma(rows.find((row) => row.id === id)!.endsOn);

    expect(endsOnOf(after, active.membershipId!)).toBe(
      addDays(endsOnOf(before, active.membershipId!), 3),
    );
    expect(endsOnOf(after, frozen.membershipId!)).toBe(
      addDays(endsOnOf(before, frozen.membershipId!), 3),
    );
    expect(endsOnOf(after, expired.membershipId!)).toBe(endsOnOf(before, expired.membershipId!));

    expect(
      await ctx.prisma.membershipEvent.count({
        where: { type: 'ADJUSTED', batchRef: 'closure-2026-08-19' },
      }),
    ).toBe(2);
  });
});
