import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Server } from 'http';
import type { PaginatedData } from '@got/shared';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { makeMember, seedPlansForTest } from './support/membership-fixtures';
import { seedStationForTest } from './support/station-fixtures';
import { addDays, asCivilDate, gymToday, toDateColumn } from '../src/common/time/gym-time';
import type { MemberListItem } from '../src/users/members.presenter';
import type { MemberCounts } from '../src/users/members.service';

jest.setTimeout(180_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const NOON = new Date('2026-08-18T04:00:00.000Z');
const TODAY = asCivilDate(gymToday(NOON, 'Asia/Manila'));

describe('GET /api/v1/members (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let deskToken: string;

  const list = async (query = ''): Promise<Envelope<PaginatedData<MemberListItem>>> => {
    const res = await request(server)
      .get(`/api/v1/members${query}`)
      .set('Authorization', `Bearer ${deskToken}`);
    return res.body as Envelope<PaginatedData<MemberListItem>>;
  };

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
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(NOON);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('authorisation', () => {
    it('refuses a member — CLIENT holds no member.read', async () => {
      const token = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
      const res = await request(server)
        .get('/api/v1/members')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    /**
     * A COACH holds `member.read` at OWN. Without the scope fragment they
     * would see the entire roster — which is precisely the leak the
     * `ScopedWhere` brand and `@Scope('user')` exist to prevent.
     */
    it('narrows a COACH at OWN scope to themselves', async () => {
      await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });
      await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });

      const coachToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });
      const coachId = await ctx.fixture.userIdFor(FIXTURE_IDS.COACH_A);

      const res = await request(server)
        .get('/api/v1/members')
        .set('Authorization', `Bearer ${coachToken}`);

      const body = res.body as Envelope<PaginatedData<MemberListItem>>;
      expect(res.status).toBe(200);
      expect(body.data?.items.map((m) => m.userId)).toEqual([coachId]);
    });
  });

  describe('the roster', () => {
    /**
     * THE DIFFERENCE FROM `/memberships`, and the reason both exist. A
     * subscription list structurally cannot show a person who has never
     * bought a plan — and those people are exactly the ones a gym rings.
     */
    it('includes a member who has never bought a plan', async () => {
      await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });

      const body = await list();
      const row = body.data?.items.find((m) => m.membership === null);

      expect(row).toBeDefined();
      expect(row?.decision).toBe('DENY');
      expect(row?.denialReason).toBe('NO_MEMBERSHIP');
    });

    it('carries contact details, which the lobby feed never does', async () => {
      const member = await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });
      await ctx.prisma.user.update({
        where: { id: member.userId },
        data: { phone: '0917 123 4567' },
      });

      const row = (await list()).data?.items.find((m) => m.userId === member.userId);
      expect(row?.phone).toBe('0917 123 4567');
      expect(row?.email).toBe(member.email);
    });

    /**
     * A statutory identifier is read at the point of a discounted sale, not
     * while browsing a list.
     */
    it('never carries the statutory ID', async () => {
      const member = await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });
      await ctx.prisma.user.update({
        where: { id: member.userId },
        data: { seniorPwdIdNo: 'OSCA-12345' },
      });

      expect(JSON.stringify(await list())).not.toContain('OSCA-12345');
    });

    /**
     * Every list projects the stored status THROUGH accessVerdict. A member
     * whose row still says ACTIVE because the nightly job missed a run must
     * read as denied here, or the CRM and the counter disagree in front of
     * them.
     */
    it('reports the DOOR verdict, not the stale stored status', async () => {
      const member = await makeMember(ctx.prisma, { state: 'STALE_ACTIVE', today: TODAY });

      const row = (await list()).data?.items.find((m) => m.userId === member.userId);
      // The column still says ACTIVE …
      expect(row?.membership?.status).toBe('ACTIVE');
      // … and the door does not.
      expect(row?.decision).toBe('DENY');
      expect(row?.denialReason).toBe('MEMBERSHIP_EXPIRED');
    });

    it('counts a member’s non-voided visits', async () => {
      const member = await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });
      const membership = await ctx.prisma.membership.findUniqueOrThrow({
        where: { userId: member.userId },
      });

      // A SELF-SCAN, not a manual entry. `CheckIn_shift_shape` requires a
      // shift whenever money or a staff action is involved, and a MANUAL row
      // with no shift is exactly the thing it refuses — correctly.
      const station = await seedStationForTest(ctx.prisma);
      await ctx.prisma.checkIn.create({
        data: {
          userId: member.userId,
          entryType: 'MEMBERSHIP',
          verdict: 'ALLOWED',
          membershipId: membership.id,
          membershipStatusAtTime: 'ACTIVE',
          occurredAt: NOON,
          businessDate: new Date(`${TODAY}T00:00:00.000Z`),
          endedAt: NOON,
          closeMethod: 'STATION_QR',
          closeStationId: station.id,
          closeStationSlot: 1,
          method: 'STATION_QR',
          recordedById: null,
          stationId: station.id,
          stationSlot: 1,
          idempotencyKey: 'member-list-fixture',
          idempotencyHash: '0'.repeat(64),
        },
      });

      const row = (await list()).data?.items.find((m) => m.userId === member.userId);
      expect(row?.checkInCount).toBe(1);
    });
  });

  describe('filters', () => {
    it('searches by name, member code and phone', async () => {
      const member = await makeMember(ctx.prisma, {
        state: 'ACTIVE',
        today: TODAY,
        firstName: 'Marisol',
        lastName: 'Reyes',
      });
      await ctx.prisma.user.update({
        where: { id: member.userId },
        data: { phone: '0917 555 0101' },
      });
      const code = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: member.userId } }))
        .memberCode as string;

      for (const term of ['marisol', 'REYES', code, '555 0101']) {
        const body = await list(`?search=${encodeURIComponent(term)}`);
        expect(body.data?.items.map((m) => m.userId)).toContain(member.userId);
      }
    });

    /**
     * `NONE` is the filter the mockup's dropdown does not have and the
     * business most needs: signed up, never converted.
     */
    it('finds members with no plan at all', async () => {
      const none = await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });
      await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });

      const body = await list('?standing=NONE');
      const ids = body.data?.items.map((m) => m.userId) ?? [];
      expect(ids).toContain(none.userId);
      expect(body.data?.items.every((m) => m.membership === null)).toBe(true);
    });

    /**
     * "Expiring" is a DATE RANGE, never a stored status — computed from
     * `endsOn`, so it holds whether or not the nightly job ever runs again.
     */
    it('finds members expiring inside the configured window', async () => {
      const soon = await makeMember(ctx.prisma, { state: 'IN_GRACE', today: TODAY });
      const later = await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });

      const body = await list('?standing=EXPIRING');
      const ids = body.data?.items.map((m) => m.userId) ?? [];
      // IN_GRACE ends yesterday, so it is EXPIRED rather than EXPIRING.
      expect(ids).not.toContain(soon.userId);
      // A term starting today ends a month out, well past the 7-day window.
      expect(ids).not.toContain(later.userId);
    });

    it('finds expired members', async () => {
      const expired = await makeMember(ctx.prisma, { state: 'EXPIRED_PAST_GRACE', today: TODAY });
      const active = await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });

      const ids = (await list('?standing=EXPIRED')).data?.items.map((m) => m.userId) ?? [];
      expect(ids).toContain(expired.userId);
      expect(ids).not.toContain(active.userId);
    });

    /**
     * A coach IS a user with a role — there is no Coach table, and the same
     * roster endpoint answers "who are our coaches".
     */
    it('filters by role, which is how the Coaches screen is built', async () => {
      await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });
      await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });

      const body = await list('?role=COACH');
      expect(body.data?.items.every((m) => m.role === 'COACH')).toBe(true);
      expect(body.data?.total).toBeGreaterThan(0);
    });

    it('paginates', async () => {
      for (let i = 0; i < 3; i += 1) {
        await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });
      }

      const body = await list('?limit=2&page=1');
      expect(body.data?.items).toHaveLength(2);
      expect(body.data?.total).toBeGreaterThanOrEqual(3);
    });
  });

  /**
   * `sort=ending` is the RENEWAL CALL SHEET — the one thing the merged
   * Subscriptions screen existed to produce, and the one thing that would
   * have been silently lost by folding it into this list.
   */
  describe('sort', () => {
    /** Puts a term's end date exactly `offset` days from today. */
    async function memberEndingIn(offset: number): Promise<string> {
      const member = await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });
      await ctx.prisma.membership.update({
        where: { id: member.membershipId as string },
        data: { endsOn: toDateColumn(addDays(TODAY, offset)) },
      });
      return member.userId;
    }

    it('returns the soonest-ending term first', async () => {
      const far = await memberEndingIn(60);
      const soon = await memberEndingIn(2);
      const middle = await memberEndingIn(20);

      const ids = (await list('?sort=ending&limit=50')).data?.items.map((m) => m.userId) ?? [];

      expect(ids.indexOf(soon)).toBeLessThan(ids.indexOf(middle));
      expect(ids.indexOf(middle)).toBeLessThan(ids.indexOf(far));
    });

    /**
     * ─────────────────────────────────────────────────────────────────────
     * THE NULLS-LAST ASSUMPTION, ASSERTED RATHER THAN TRUSTED.
     *
     * `User.membership` is an optional to-one relation, so a member who never
     * bought a plan sorts on a NULL `endsOn`. Postgres puts NULLs last on an
     * ASC ordering — which is what a call sheet wants — but Prisma exposes no
     * `nulls` option for a RELATION ordering, so the query cannot state it.
     * If a Prisma upgrade ever changed the emitted SQL, the call sheet would
     * quietly open with a page of people who have nothing to renew, and
     * nothing but this test would notice.
     * ─────────────────────────────────────────────────────────────────────
     */
    it('sinks members with no plan at all to the bottom', async () => {
      const { userId: planless } = await makeMember(ctx.prisma, {
        state: 'NO_MEMBERSHIP',
        today: TODAY,
      });
      const withPlan = await memberEndingIn(30);

      const ids = (await list('?sort=ending&limit=50')).data?.items.map((m) => m.userId) ?? [];

      expect(ids.indexOf(planless)).toBeGreaterThan(ids.indexOf(withPlan));
      expect(ids[ids.length - 1]).toBe(planless);
    });

    /** `@IsIn(MEMBER_SORTS)` — an unrecognised sort is a 400, never a silent
     *  fallback to the default order. */
    it('400s an unknown sort rather than ignoring it', async () => {
      const res = await request(server)
        .get('/api/v1/members?sort=garbage')
        .set('Authorization', `Bearer ${deskToken}`);

      expect(res.status).toBe(400);
    });

    it('combines with a standing filter, and holds across a page boundary', async () => {
      // Three inside the 7-day window, one well outside it.
      const third = await memberEndingIn(6);
      const first = await memberEndingIn(1);
      const second = await memberEndingIn(3);
      await memberEndingIn(45);

      const page1 = await list('?sort=ending&standing=EXPIRING&limit=2&page=1');
      const page2 = await list('?sort=ending&standing=EXPIRING&limit=2&page=2');

      expect(page1.data?.items.map((m) => m.userId)).toEqual([first, second]);
      expect(page2.data?.items.map((m) => m.userId)).toEqual([third]);
      expect(page1.data?.total).toBe(3);
    });
  });

  /**
   * The roster's KPI tiles. The reason this is an endpoint rather than four
   * `limit=1` list calls is that the tiles and the table now share ONE filter
   * builder — a tile reading 42 beside a filter showing 39 is structurally
   * impossible, not merely unlikely. These tests are that claim.
   */
  describe('GET /members/counts', () => {
    const counts = async (query = ''): Promise<Envelope<MemberCounts>> => {
      const res = await request(server)
        .get(`/api/v1/members/counts${query}`)
        .set('Authorization', `Bearer ${deskToken}`);
      return res.body as Envelope<MemberCounts>;
    };

    /**
     * `/members/counts` and `/members/:id` compete for the same path shape.
     * Declared after `@Get(':id')`, this request would reach `ParseUUIDPipe`
     * and 400 on the literal string "counts".
     */
    it('routes to counts, not to the :id handler', async () => {
      const res = await request(server)
        .get('/api/v1/members/counts')
        .set('Authorization', `Bearer ${deskToken}`);

      expect(res.status).toBe(200);
      expect((res.body as Envelope<MemberCounts>).data).toHaveProperty('expiringSoonDays');
    });

    it('agrees with the total of the equivalent /members?standing=… call', async () => {
      await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });
      await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });
      await makeMember(ctx.prisma, { state: 'EXPIRED_PAST_GRACE', today: TODAY });
      await makeMember(ctx.prisma, { state: 'NO_MEMBERSHIP', today: TODAY });

      const tiles = (await counts()).data!;

      for (const standing of ['ACTIVE', 'EXPIRING', 'EXPIRED', 'NONE'] as const) {
        const total = (await list(`?standing=${standing}&limit=1`)).data?.total;
        const key = standing.toLowerCase() as 'active' | 'expiring' | 'expired' | 'none';
        expect(tiles[key]).toBe(total);
      }
      expect(tiles.total).toBe((await list('?limit=1')).data?.total);
    });

    it('carries expiringSoonDays so the tile caption never hardcodes a 7', async () => {
      expect((await counts()).data?.expiringSoonDays).toBeGreaterThanOrEqual(1);
      expect((await counts()).data?.expiringSoonDays).toBeLessThanOrEqual(30);
    });

    it('honours search, exactly as the list does', async () => {
      const marisol = await makeMember(ctx.prisma, {
        state: 'ACTIVE',
        today: TODAY,
        firstName: 'Marisol',
        lastName: 'Reyes',
      });
      await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });

      const tiles = (await counts('?search=marisol')).data!;
      expect(tiles.total).toBe(1);
      expect(tiles.active).toBe(1);
      expect(marisol.userId).toBeTruthy();
    });

    it('refuses a CLIENT — same member.read key as the list', async () => {
      const token = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
      const res = await request(server)
        .get('/api/v1/members/counts')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    /** A COACH holds member.read at OWN, so the tiles must narrow with the
     *  table rather than reporting the whole roster back to them. */
    it('narrows a COACH at OWN scope', async () => {
      await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });
      await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });

      const coachToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });
      const res = await request(server)
        .get('/api/v1/members/counts')
        .set('Authorization', `Bearer ${coachToken}`);

      const body = res.body as Envelope<MemberCounts>;
      expect(res.status).toBe(200);
      // The coach themselves and nobody else — they have no assigned members.
      expect(body.data?.total).toBe(1);
    });
  });

  /**
   * The Subscriptions screen showed a "cancelling" sub-line under the end
   * date. Folding that screen into the roster kept the fact, so the field has
   * to reach a LIST row and not only the membership detail.
   */
  describe('cancellation notice on a list row', () => {
    it('carries membership.cancelRequestedOn after notice is taken', async () => {
      const member = await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });

      const before = (await list()).data?.items.find((m) => m.userId === member.userId);
      expect(before?.membership?.cancelRequestedOn).toBeNull();

      const adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
      const res = await request(server)
        .post(`/api/v1/memberships/${member.membershipId as string}/cancel-request`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'moving to another city' });
      expect(res.status).toBe(201);

      const after = (await list()).data?.items.find((m) => m.userId === member.userId);
      expect(after?.membership?.cancelRequestedOn).toBe(TODAY);
    });
  });

  describe('GET /members/:id', () => {
    it('returns one member', async () => {
      const member = await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });

      const res = await request(server)
        .get(`/api/v1/members/${member.userId}`)
        .set('Authorization', `Bearer ${deskToken}`);

      expect(res.status).toBe(200);
      expect((res.body as Envelope<MemberListItem>).data?.userId).toBe(member.userId);
    });

    /**
     * 404, NEVER 403. A 403 confirms the row exists and turns this endpoint
     * into an enumeration oracle over the whole member base.
     */
    it('404s a scoped miss rather than 403ing it', async () => {
      const other = await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });
      const coachToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });

      const res = await request(server)
        .get(`/api/v1/members/${other.userId}`)
        .set('Authorization', `Bearer ${coachToken}`);

      expect(res.status).toBe(404);
      expect((res.body as Envelope<never>).error?.code).toBe('MEMBER_NOT_FOUND');
    });

    /** Soft-deleted members are invisible to every read. */
    it('404s a soft-deleted member', async () => {
      const member = await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });
      await ctx.prisma.user.update({
        where: { id: member.userId },
        data: { deletedAt: new Date() },
      });

      const res = await request(server)
        .get(`/api/v1/members/${member.userId}`)
        .set('Authorization', `Bearer ${deskToken}`);
      expect(res.status).toBe(404);
    });
  });
});
