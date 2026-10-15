import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Server } from 'http';
import type {
  ClassRegisterEntryWire,
  ClassSessionWire,
  MarkAttendanceResultWire,
  MemberNoticeFeedWire,
  MyBookingWindowWire,
  MyBookingWire,
} from '@got/shared';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { makeMember, seedPlansForTest } from './support/membership-fixtures';
import { GymConfigService } from '../src/config/gym.config';
import {
  addDays,
  gymToday,
  toDateColumn,
  zonedTimeToInstant,
  type CivilDate,
} from '../src/common/time/gym-time';

jest.setTimeout(120_000);

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Members beyond the shared fixtures. Minted, never inserted: tokenFor provisions them. */
const CLIENT_C = '0b000000-0000-4000-8000-0000000c1c01';
const CLIENT_NO_PLAN = '0b000000-0000-4000-8000-0000000c1d01';
const CLIENT_QUARTERLY = '0b000000-0000-4000-8000-0000000c1e01';
const CLIENT_EXPIRED = '0b000000-0000-4000-8000-0000000c1f01';

/**
 * Class booking, end to end over HTTP (class-booking fixes, 2026-10-11): the
 * member's own book and cancel with the plan, window and waitlist rules; the
 * desk adding and removing members under `booking.manage`; the register with
 * its marker; capacity raises and cancellations; the booking window; and the
 * member notices each change leaves in the right bell — and only there.
 *
 * Everything runs on the real clock (the routes read `new Date()`), so every
 * class is placed relative to now: "in two days" at gym noon, "in an hour",
 * "started ten minutes ago".
 */
describe('class bookings (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let timeZone: string;
  let today: CivilDate;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
    timeZone = ctx.app.get(GymConfigService, { strict: false }).timeZone;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await seedPlansForTest(ctx.prisma);
    today = gymToday(new Date(), timeZone);

    const people: Array<[string, 'ADMIN' | 'FRONT_DESK' | 'COACH' | 'CLIENT', string, string]> = [
      ['admin', 'ADMIN', FIXTURE_IDS.ADMIN, 'Alex'],
      ['desk', 'FRONT_DESK', FIXTURE_IDS.FRONT_DESK, 'Dana'],
      ['coach', 'COACH', FIXTURE_IDS.COACH_A, 'Coach'],
      ['a', 'CLIENT', FIXTURE_IDS.CLIENT_A, 'Ana'],
      ['b', 'CLIENT', FIXTURE_IDS.CLIENT_B, 'Ben'],
      ['c', 'CLIENT', CLIENT_C, 'Cora'],
      ['noPlan', 'CLIENT', CLIENT_NO_PLAN, 'Nico'],
      ['quarterly', 'CLIENT', CLIENT_QUARTERLY, 'Quin'],
      ['expired', 'CLIENT', CLIENT_EXPIRED, 'Ed'],
    ];
    for (const [name, role, supabaseId, firstName] of people) {
      tokens[name] = await ctx.fixture.tokenFor(role, {
        supabaseId,
        firstName,
        lastName: 'Fixture',
      });
      ids[name] = await ctx.fixture.userIdFor(supabaseId);
    }

    for (const name of ['a', 'b', 'c']) {
      await makeMember(ctx.prisma, { state: 'ACTIVE', today, userId: ids[name] });
    }
    await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      today,
      userId: ids['quarterly'],
      planCode: 'QUARTERLY',
    });
    await makeMember(ctx.prisma, { state: 'EXPIRED_PAST_GRACE', today, userId: ids['expired'] });
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Gym noon, `days` gym days from today. */
  const noonIn = (days: number): Date =>
    zonedTimeToInstant(addDays(today, days), '12:00', timeZone);
  const fromNow = (ms: number): Date => new Date(Date.now() + ms);

  /** A one-hour class starting at `startsAt`, filed under the gym day it starts. */
  async function classAt(startsAt: Date, capacity = 10): Promise<string> {
    const row = await ctx.prisma.classSession.create({
      data: {
        title: 'Spin',
        coachId: ids['coach'],
        createdById: ids['admin'],
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR),
        businessDate: toDateColumn(gymToday(startsAt, timeZone)),
        capacity,
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * A place written straight to the table — for states the routes rightly
   * refuse to create now (a seat in a class that has started, a waitlist
   * place after the cutoff). A seat it takes is counted.
   */
  async function place(
    sessionId: string,
    who: string,
    status: 'BOOKED' | 'WAITLISTED',
    bookedAt: Date,
  ): Promise<string> {
    const row = await ctx.prisma.classBooking.create({
      data: {
        sessionId,
        userId: ids[who],
        status,
        activeKey: `${sessionId}:${ids[who]}`,
        bookedAt,
      },
      select: { id: true },
    });
    if (status === 'BOOKED') {
      await ctx.prisma.classSession.update({
        where: { id: sessionId },
        data: { bookedCount: { increment: 1 } },
      });
    }
    return row.id;
  }

  const auth = (who: string): [string, string] => ['Authorization', `Bearer ${tokens[who]}`];

  const book = (who: string, sessionId: string) =>
    request(server)
      .post(`/api/v1/class-sessions/${sessionId}/bookings`)
      .set(...auth(who))
      .set('Idempotency-Key', randomUUID());

  const cancel = (who: string, sessionId: string) =>
    request(server)
      .delete(`/api/v1/class-sessions/${sessionId}/bookings`)
      .set(...auth(who));

  const add = (who: string, sessionId: string, userId: string) =>
    request(server)
      .post(`/api/v1/admin/class-sessions/${sessionId}/bookings`)
      .set(...auth(who))
      .set('Idempotency-Key', randomUUID())
      .send({ userId });

  const remove = (who: string, bookingId: string, reason: string) =>
    request(server)
      .post(`/api/v1/admin/class-sessions/bookings/${bookingId}/remove`)
      .set(...auth(who))
      .send({ reason });

  async function myBookings(who: string): Promise<MyBookingWire[]> {
    const response = await request(server)
      .get('/api/v1/me/bookings')
      .set(...auth(who))
      .expect(200);
    return (response.body as Envelope<MyBookingWire[]>).data ?? [];
  }

  async function notices(who: string): Promise<MemberNoticeFeedWire['items']> {
    const response = await request(server)
      .get('/api/v1/me/notices')
      .set(...auth(who))
      .expect(200);
    return (response.body as Envelope<MemberNoticeFeedWire>).data?.items ?? [];
  }

  async function register(sessionId: string, who = 'coach'): Promise<ClassRegisterEntryWire[]> {
    const response = await request(server)
      .get(`/api/v1/class-sessions/${sessionId}/register`)
      .set(...auth(who))
      .expect(200);
    return (response.body as Envelope<ClassRegisterEntryWire[]>).data ?? [];
  }

  const dataOf = <T>(response: request.Response): T => (response.body as Envelope<T>).data as T;
  const errorOf = (response: request.Response) => (response.body as Envelope<never>).error;

  // ── the member's own booking ─────────────────────────────────────────────

  describe('a member books', () => {
    it('takes a free seat, and a full class puts the next member on the waitlist with their place', async () => {
      const sessionId = await classAt(noonIn(2), 1);

      const first = await book('a', sessionId).expect(201);
      expect(dataOf<MyBookingWire>(first)).toMatchObject({
        status: 'BOOKED',
        addedByStaff: false,
        session: { bookedCount: 1, waitlistCount: 0 },
      });

      const second = await book('b', sessionId).expect(201);
      expect(dataOf<MyBookingWire>(second)).toMatchObject({
        status: 'WAITLISTED',
        waitlistPosition: 1,
        session: { waitlistCount: 1 },
      });

      const again = await book('a', sessionId).expect(409);
      expect(errorOf(again)?.code).toBe('ALREADY_BOOKED');
    });

    it('refuses a member with no plan, in their own words, and takes nothing', async () => {
      const sessionId = await classAt(noonIn(2), 1);

      const response = await book('noPlan', sessionId).expect(422);

      expect(errorOf(response)).toEqual({
        code: 'BOOKING_PLAN_REQUIRED',
        message:
          'You need a plan to book classes. Choose one on your Subscription page or at the desk.',
        details: { reason: 'NO_MEMBERSHIP', relevantDate: null },
      });
      expect(await ctx.prisma.classBooking.count()).toBe(0);
    });

    // Grace days do not count for a booking (owner, 2026-10-11).
    it('refuses a lapsed plan, grace or not', async () => {
      const sessionId = await classAt(noonIn(2), 1);

      const response = await book('expired', sessionId).expect(422);

      expect(errorOf(response)).toMatchObject({
        code: 'BOOKING_PLAN_REQUIRED',
        message: 'Your plan has ended. Renew to book classes.',
        details: { reason: 'MEMBERSHIP_EXPIRED', relevantDate: null },
      });
    });

    it('opens 14 gym days ahead, today included — and 21 on a priority plan', async () => {
      await book('a', await classAt(noonIn(13))).expect(201);

      const beyond = await book('a', await classAt(noonIn(14))).expect(422);
      expect(errorOf(beyond)).toMatchObject({
        code: 'BOOKING_WINDOW_NOT_OPEN',
        details: { opensOn: addDays(today, 1) },
      });

      await book('quarterly', await classAt(noonIn(20))).expect(201);
      const priorityBeyond = await book('quarterly', await classAt(noonIn(21))).expect(422);
      expect(errorOf(priorityBeyond)?.code).toBe('BOOKING_WINDOW_NOT_OPEN');
    });

    it('closes the waitlist two hours before the start', async () => {
      const sessionId = await classAt(fromNow(HOUR), 1);
      await book('b', sessionId).expect(201);

      const response = await book('a', sessionId).expect(422);

      expect(errorOf(response)?.code).toBe('WAITLIST_CLOSED');
      expect(await ctx.prisma.classBooking.count({ where: { status: 'WAITLISTED' } })).toBe(0);
    });

    it('lets a member still waiting take a seat freed after the cutoff', async () => {
      const sessionId = await classAt(fromNow(HOUR), 1);
      await place(sessionId, 'b', 'BOOKED', fromNow(-2 * HOUR));
      await place(sessionId, 'a', 'WAITLISTED', fromNow(-HOUR));

      // Still full: the waitlist has closed, and the answer says what that
      // means for a member still on it.
      const full = await book('a', sessionId).expect(409);
      expect(errorOf(full)).toMatchObject({
        code: 'ALREADY_BOOKED',
        message:
          "Someone else took that place first. You're still on the waitlist, but it has closed, so a place now goes to whoever books it first.",
      });

      await cancel('b', sessionId).expect(200);
      // After the cutoff nobody is moved up by themselves…
      expect((await myBookings('a'))[0]).toMatchObject({
        status: 'WAITLISTED',
        waitlistPosition: null,
      });

      // …but the member can take the seat.
      const taken = await book('a', sessionId).expect(201);
      expect(dataOf<MyBookingWire>(taken)).toMatchObject({ status: 'BOOKED', promotedAt: null });
    });
  });

  // ── cancelling, and the waitlist moving up ───────────────────────────────

  describe('the waitlist moves up', () => {
    it('hands a cancelled seat to the first person waiting, and tells only them', async () => {
      const sessionId = await classAt(noonIn(2), 1);
      await book('a', sessionId).expect(201);
      await book('b', sessionId).expect(201);
      await book('c', sessionId).expect(201);

      const cancelled = await cancel('a', sessionId).expect(200);
      expect(dataOf<MyBookingWire>(cancelled)).toMatchObject({
        status: 'CANCELLED',
        cancelledBy: 'MEMBER',
        removalReason: null,
      });

      expect((await myBookings('b'))[0]).toMatchObject({ status: 'BOOKED' });
      expect((await myBookings('b'))[0]?.promotedAt).not.toBeNull();
      expect((await myBookings('c'))[0]).toMatchObject({
        status: 'WAITLISTED',
        waitlistPosition: 1,
      });

      const bell = await notices('b');
      expect(bell).toHaveLength(1);
      expect(bell[0]).toMatchObject({
        kind: 'CLASS_PROMOTED',
        linkPath: `/portal/book?date=${addDays(today, 2)}`,
        isNew: true,
      });
      expect(bell[0]?.title.startsWith("You're in: Spin, ")).toBe(true);
      expect(await notices('c')).toEqual([]);
      expect(await notices('a')).toEqual([]);
    });

    // The desk's add skipped the plan check (owner: "the desk can still add
    // someone by hand"), and that holds when the queue reaches them.
    it('moves up a member the desk put on the waitlist, plan or no plan', async () => {
      const sessionId = await classAt(noonIn(2), 1);
      await book('a', sessionId).expect(201);
      const added = dataOf<ClassRegisterEntryWire>(
        await add('desk', sessionId, ids['noPlan']).expect(201),
      );
      expect(added).toMatchObject({ status: 'WAITLISTED', waitlistPosition: 1 });

      await cancel('a', sessionId).expect(200);

      expect((await myBookings('noPlan'))[0]).toMatchObject({
        status: 'BOOKED',
        addedByStaff: true,
      });
      expect((await notices('noPlan')).map((notice) => notice.kind).sort()).toEqual([
        'BOOKING_ADDED',
        'CLASS_PROMOTED',
      ]);
    });

    it('moves the queue up when the places are raised', async () => {
      const sessionId = await classAt(noonIn(2), 1);
      await book('a', sessionId).expect(201);
      await book('b', sessionId).expect(201);
      await book('c', sessionId).expect(201);

      const response = await request(server)
        .patch(`/api/v1/admin/class-sessions/${sessionId}`)
        .set(...auth('admin'))
        .send({ capacity: 2 })
        .expect(200);

      expect(dataOf<ClassSessionWire>(response)).toMatchObject({
        capacity: 2,
        bookedCount: 2,
        waitlistCount: 1,
      });
      expect((await myBookings('b'))[0]?.status).toBe('BOOKED');
      expect((await myBookings('c'))[0]?.status).toBe('WAITLISTED');
      expect((await notices('b')).map((notice) => notice.kind)).toEqual(['CLASS_PROMOTED']);
    });
  });

  // ── the desk's hand on who is in a class ─────────────────────────────────

  describe('the desk adds and removes members — booking.manage', () => {
    it('lets FRONT_DESK and ADMIN add and remove, and nobody else', async () => {
      const sessionId = await classAt(noonIn(2), 5);

      await add('a', sessionId, ids['b']).expect(403);
      await add('coach', sessionId, ids['b']).expect(403);
      await request(server)
        .post(`/api/v1/admin/class-sessions/${sessionId}/bookings`)
        .set('Idempotency-Key', randomUUID())
        .send({ userId: ids['b'] })
        .expect(401);

      const byDesk = dataOf<ClassRegisterEntryWire>(
        await add('desk', sessionId, ids['b']).expect(201),
      );
      await add('admin', sessionId, ids['c']).expect(201);

      await remove('a', byDesk.bookingId, 'Not today').expect(403);
      await remove('coach', byDesk.bookingId, 'Not today').expect(403);
      await remove('desk', byDesk.bookingId, 'Not today').expect(200);
    });

    // POST with @Idempotent: the client's key is what turns a double-clicked
    // confirm into one booking.
    it('asks for an Idempotency-Key on an add', async () => {
      const sessionId = await classAt(noonIn(2), 5);
      await request(server)
        .post(`/api/v1/admin/class-sessions/${sessionId}/bookings`)
        .set(...auth('desk'))
        .send({ userId: ids['a'] })
        .expect(400);
    });

    it('adds a member by hand — no plan needed — who sees it in their bookings and their bell', async () => {
      const sessionId = await classAt(noonIn(2), 5);

      const entry = dataOf<ClassRegisterEntryWire>(
        await add('desk', sessionId, ids['noPlan']).expect(201),
      );

      expect(entry).toMatchObject({
        status: 'BOOKED',
        addedByStaff: true,
        member: { firstName: 'Nico', lastName: 'Fixture' },
      });
      expect((await myBookings('noPlan'))[0]).toMatchObject({
        status: 'BOOKED',
        addedByStaff: true,
      });
      expect((await notices('noPlan')).map((notice) => notice.kind)).toEqual(['BOOKING_ADDED']);
    });

    it('refuses a staff account — MEMBER_NOT_BOOKABLE', async () => {
      const sessionId = await classAt(noonIn(2), 5);
      const response = await add('desk', sessionId, ids['coach']).expect(422);
      expect(errorOf(response)?.code).toBe('MEMBER_NOT_BOOKABLE');
    });

    it('refuses a class that has finished — CLASS_FINISHED', async () => {
      const sessionId = await classAt(fromNow(-2 * HOUR), 5);
      const response = await add('desk', sessionId, ids['a']).expect(422);
      expect(errorOf(response)?.code).toBe('CLASS_FINISHED');
    });

    it('removes a member with a reason they are shown, and the next person moves up', async () => {
      const sessionId = await classAt(noonIn(2), 1);
      const mine = dataOf<MyBookingWire>(await book('a', sessionId).expect(201));
      await book('b', sessionId).expect(201);

      const removed = await remove(
        'desk',
        mine.bookingId,
        '  Class moved to the small studio ',
      ).expect(200);
      expect(dataOf<ClassRegisterEntryWire>(removed)).toMatchObject({
        bookingId: mine.bookingId,
        status: 'CANCELLED',
      });

      expect((await myBookings('a'))[0]).toMatchObject({
        status: 'CANCELLED',
        cancelledBy: 'GYM',
        removalReason: 'Class moved to the small studio',
      });
      expect(await notices('a')).toEqual([
        expect.objectContaining({
          kind: 'BOOKING_REMOVED',
          body: 'Class moved to the small studio',
        }),
      ]);
      expect((await myBookings('b'))[0]?.status).toBe('BOOKED');
      expect((await notices('b')).map((notice) => notice.kind)).toEqual(['CLASS_PROMOTED']);
    });

    it('asks for a real reason, and 404s an unknown booking', async () => {
      const sessionId = await classAt(noonIn(2), 1);
      const mine = dataOf<MyBookingWire>(await book('a', sessionId).expect(201));

      await remove('desk', mine.bookingId, 'no').expect(400);
      const unknown = await remove('desk', randomUUID(), 'Class moved').expect(404);
      expect(errorOf(unknown)?.code).toBe('BOOKING_NOT_FOUND');
    });
  });

  // ── the register ─────────────────────────────────────────────────────────

  describe('the register', () => {
    it('lists seats, then the waitlist numbered, and records who marked each entry', async () => {
      const sessionId = await classAt(fromNow(-10 * MINUTE), 2);
      const seatA = await place(sessionId, 'a', 'BOOKED', fromNow(-3 * HOUR));
      await place(sessionId, 'b', 'BOOKED', fromNow(-2 * HOUR));
      await place(sessionId, 'c', 'WAITLISTED', fromNow(-HOUR));

      const before = await register(sessionId);
      expect(before.map((row) => [row.member.firstName, row.status, row.waitlistPosition])).toEqual(
        [
          ['Ana', 'BOOKED', null],
          ['Ben', 'BOOKED', null],
          ['Cora', 'WAITLISTED', 1],
        ],
      );

      const marked = await request(server)
        .post(`/api/v1/admin/class-sessions/bookings/${seatA}/attendance`)
        .set(...auth('coach'))
        .send({ attended: true })
        .expect(201);
      expect(dataOf<MarkAttendanceResultWire>(marked)).toMatchObject({
        bookingId: seatA,
        status: 'ATTENDED',
        markedBy: { firstName: 'Coach', lastName: 'Fixture' },
      });

      const after = await register(sessionId, 'desk');
      // Marked, and still first: it no longer sinks below the waitlist.
      expect(after[0]).toMatchObject({
        bookingId: seatA,
        status: 'ATTENDED',
        markedBy: { firstName: 'Coach', lastName: 'Fixture' },
      });
      expect(after[0]?.markedAt).not.toBeNull();
    });

    it('is staff-only, and 404s a class that does not exist', async () => {
      const sessionId = await classAt(noonIn(2), 2);
      await request(server)
        .get(`/api/v1/class-sessions/${sessionId}/register`)
        .set(...auth('a'))
        .expect(403);

      const unknown = await request(server)
        .get(`/api/v1/class-sessions/${randomUUID()}/register`)
        .set(...auth('coach'))
        .expect(404);
      expect(errorOf(unknown)?.code).toBe('CLASS_NOT_FOUND');
    });
  });

  // ── editing and cancelling a class ───────────────────────────────────────

  describe('the timetable', () => {
    it('tells everybody holding a place when the time changes', async () => {
      const startsAt = noonIn(2);
      const sessionId = await classAt(startsAt, 1);
      await book('a', sessionId).expect(201);
      await book('b', sessionId).expect(201);

      await request(server)
        .patch(`/api/v1/admin/class-sessions/${sessionId}`)
        .set(...auth('admin'))
        .send({
          startsAt: new Date(startsAt.getTime() + HOUR).toISOString(),
          endsAt: new Date(startsAt.getTime() + 2 * HOUR).toISOString(),
        })
        .expect(200);

      expect((await notices('a')).map((notice) => notice.kind)).toEqual(['CLASS_CHANGED']);
      expect((await notices('b')).map((notice) => notice.kind)).toEqual(['CLASS_CHANGED']);
      expect(await notices('c')).toEqual([]);
    });

    it('cancels a class, tells everybody holding a place why, and refuses their cancel after (F16)', async () => {
      const sessionId = await classAt(noonIn(2), 1);
      await book('a', sessionId).expect(201);
      await book('b', sessionId).expect(201);

      await request(server)
        .post(`/api/v1/admin/class-sessions/${sessionId}/cancel`)
        .set(...auth('admin'))
        .send({ reason: 'Coach is unwell' })
        .expect(201);

      for (const who of ['a', 'b']) {
        expect(await notices(who)).toEqual([
          expect.objectContaining({ kind: 'CLASS_CANCELLED', body: 'Coach is unwell' }),
        ]);
      }
      const refused = await cancel('a', sessionId).expect(422);
      expect(errorOf(refused)?.code).toBe('CLASS_CANCELLED');
    });

    // The register opens 30 minutes before the start, so a class called off
    // at the last minute can carry marks. It never ran: the marked members are
    // told too, and their marks go back to a plain seat.
    it('cancels a class whose register has opened, tells the members marked early, and undoes their marks', async () => {
      const sessionId = await classAt(fromNow(20 * MINUTE), 2);
      const seatA = await place(sessionId, 'a', 'BOOKED', fromNow(-2 * HOUR));
      await place(sessionId, 'b', 'BOOKED', fromNow(-HOUR));

      await request(server)
        .post(`/api/v1/admin/class-sessions/bookings/${seatA}/attendance`)
        .set(...auth('coach'))
        .send({ attended: true })
        .expect(201);

      const cancelled = await request(server)
        .post(`/api/v1/admin/class-sessions/${sessionId}/cancel`)
        .set(...auth('admin'))
        .send({ reason: 'Coach is unwell' })
        .expect(201);
      // Each was a seat already: the "affected" count does not move.
      expect(dataOf<ClassSessionWire>(cancelled)).toMatchObject({ bookedCount: 2 });

      for (const who of ['a', 'b']) {
        expect(await notices(who)).toEqual([
          expect.objectContaining({ kind: 'CLASS_CANCELLED', body: 'Coach is unwell' }),
        ]);
      }
      expect(
        await ctx.prisma.classBooking.findUniqueOrThrow({
          where: { id: seatA },
          select: { status: true, attendedAt: true, markedAt: true, markedById: true },
        }),
      ).toEqual({ status: 'BOOKED', attendedAt: null, markedAt: null, markedById: null });
    });

    // 06:00 typed for 18:00: a class in the past could never be edited or
    // cancelled afterwards, so it is refused before it exists.
    it('refuses to create a class in the past, or to move one there', async () => {
      const startsAt = fromNow(-HOUR);
      const created = await request(server)
        .post('/api/v1/admin/class-sessions')
        .set(...auth('admin'))
        .set('Idempotency-Key', randomUUID())
        .send({
          title: 'Spin',
          coachId: ids['coach'],
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + HOUR).toISOString(),
          capacity: 10,
        })
        .expect(422);
      expect(errorOf(created)).toMatchObject({
        code: 'CLASS_ALREADY_STARTED',
        message: 'That start time has already passed. Check the date and the time.',
      });
      expect(await ctx.prisma.classSession.count()).toBe(0);

      const sessionId = await classAt(noonIn(2), 5);
      const moved = await request(server)
        .patch(`/api/v1/admin/class-sessions/${sessionId}`)
        .set(...auth('admin'))
        .send({ startsAt: startsAt.toISOString() })
        .expect(422);
      expect(errorOf(moved)?.code).toBe('CLASS_ALREADY_STARTED');
    });

    it('refuses to cancel a class that has started, or to edit one that has ended', async () => {
      const running = await classAt(fromNow(-10 * MINUTE), 5);
      const cancelled = await request(server)
        .post(`/api/v1/admin/class-sessions/${running}/cancel`)
        .set(...auth('admin'))
        .send({ reason: 'Too late' })
        .expect(422);
      expect(errorOf(cancelled)?.code).toBe('CLASS_ALREADY_STARTED');

      const ended = await classAt(fromNow(-2 * HOUR), 5);
      const edited = await request(server)
        .patch(`/api/v1/admin/class-sessions/${ended}`)
        .set(...auth('admin'))
        .send({ title: 'Late Spin' })
        .expect(422);
      expect(errorOf(edited)?.code).toBe('CLASS_FINISHED');
    });
  });

  // ── GET /me/booking-window ───────────────────────────────────────────────

  describe('GET /me/booking-window', () => {
    const window = async (who: string): Promise<MyBookingWindowWire> => {
      const response = await request(server)
        .get('/api/v1/me/booking-window')
        .set(...auth(who))
        .expect(200);
      return dataOf<MyBookingWindowWire>(response);
    };

    it('gives a standard plan 14 days and a priority plan 21, today included', async () => {
      expect(await window('a')).toMatchObject({
        windowDays: 14,
        lastBookableDay: addDays(today, 13),
        eligibleToday: true,
        reason: null,
        message: null,
      });
      expect((await window('a')).planCoversUntil).not.toBeNull();
      expect(await window('quarterly')).toMatchObject({
        windowDays: 21,
        lastBookableDay: addDays(today, 20),
      });
    });

    it('says why a member without a plan cannot book', async () => {
      expect(await window('noPlan')).toEqual({
        windowDays: 14,
        lastBookableDay: addDays(today, 13),
        eligibleToday: false,
        reason: 'NO_MEMBERSHIP',
        message:
          'You need a plan to book classes. Choose one on your Subscription page or at the desk.',
        planCoversUntil: null,
      });
    });

    it('is keyless — any signed-in account, and nobody signed out', async () => {
      await window('desk');
      await request(server).get('/api/v1/me/booking-window').expect(401);
    });
  });
});
