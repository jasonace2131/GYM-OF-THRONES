import { randomUUID } from 'node:crypto';
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

interface Person {
  firstName: string;
}

interface Measurement {
  id: string;
  businessDate: string;
  weightGrams: number | null;
  heightMm: number | null;
  bodyFatPermille: number | null;
  notes: string | null;
  recordedBy: Person | null;
  updatedBy: Person | null;
}

interface Goal {
  id: string;
  name: string;
  currentHundredths: number;
  recordedBy: Person | null;
  updatedBy: Person | null;
}

interface Summary {
  measurements: Measurement[];
  goals: Goal[];
  coach: { firstName: string; lastName: string } | null;
}

interface CoachView extends Summary {
  member: { id: string; firstName: string; lastName: string; memberCode: string | null };
}

const DEV_SUPABASE_ID = '0a000000-0000-4000-8000-0000000dde01';
const NOBODY = '0a000000-0000-4000-8000-00000000e404';

/**
 * Coach-recorded progress, end to end.
 *
 * The file runs top to bottom as one story: COACH_A is assigned CLIENT_A and
 * records; the member reads; access is refused every way it should be; the
 * member is handed to COACH_B, who corrects; old self-recorded rows stay
 * frozen. Order matters, which is why the fixtures live in `beforeAll`.
 */
describe('coach-recorded progress (e2e)', () => {
  let ctx: TestApp;
  let server: Server;

  let adminToken: string;
  let frontDeskToken: string;
  let coachAToken: string;
  let coachBToken: string;
  let clientAToken: string;
  let devToken: string;

  let coachAId: string;
  let coachBId: string;
  let clientAId: string;
  let clientBId: string;
  let deletedId: string;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const coachPath = (memberId: string, rest: string): string =>
    `/api/v1/me/coaching/members/${memberId}/${rest}`;

  const assign = async (coachId: string, memberId: string): Promise<string> => {
    const res = await request(server)
      .post('/api/v1/coach-assignments')
      .set(as(adminToken))
      .send({ coachId, memberId })
      .expect(201);
    return (res.body as Envelope<{ id: string }>).data!.id;
  };

  const myProgress = async (): Promise<Summary> => {
    const res = await request(server).get('/api/v1/me/progress').set(as(clientAToken)).expect(200);
    return (res.body as Envelope<Summary>).data!;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
    await resetDatabase(ctx.prisma);

    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    frontDeskToken = await ctx.fixture.tokenFor('FRONT_DESK', {
      supabaseId: FIXTURE_IDS.FRONT_DESK,
    });
    coachAToken = await ctx.fixture.tokenFor('COACH', {
      supabaseId: FIXTURE_IDS.COACH_A,
      firstName: 'Ana',
      lastName: 'Reyes',
    });
    coachBToken = await ctx.fixture.tokenFor('COACH', {
      supabaseId: FIXTURE_IDS.COACH_B,
      firstName: 'Ben',
      lastName: 'Cruz',
    });
    clientAToken = await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_A });
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_B });
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: FIXTURE_IDS.CLIENT_DELETED });
    devToken = await ctx.fixture.tokenFor('DEV', { supabaseId: DEV_SUPABASE_ID });

    coachAId = await ctx.fixture.userIdFor(FIXTURE_IDS.COACH_A);
    coachBId = await ctx.fixture.userIdFor(FIXTURE_IDS.COACH_B);
    clientAId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_A);
    clientBId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_B);
    deletedId = await ctx.fixture.userIdFor(FIXTURE_IDS.CLIENT_DELETED);

    await assign(coachAId, clientAId);
    // Assigned, then soft-deleted: the assignment stays ACTIVE (a soft delete
    // does not end it), which is exactly the case the scope must still refuse.
    await assign(coachAId, deletedId);
    await ctx.prisma.user.update({ where: { id: deletedId }, data: { deletedAt: new Date() } });
  });

  afterAll(async () => {
    await ctx.close();
  });

  let todayId: string;

  it('COACH_A records a weight: 201, and the member sees who recorded it and who coaches them', async () => {
    const res = await request(server)
      .post(coachPath(clientAId, 'measurements'))
      .set(as(coachAToken))
      .send({ weightGrams: 72_400 })
      .expect(201);

    const recorded = (res.body as Envelope<Measurement>).data!;
    todayId = recorded.id;
    expect(recorded.recordedBy).toEqual({ firstName: 'Ana' });

    const mine = await myProgress();
    expect(mine.coach).toEqual({ firstName: 'Ana', lastName: 'Reyes' });
    expect(mine.measurements).toHaveLength(1);
    expect(mine.measurements[0]).toMatchObject({
      id: todayId,
      weightGrams: 72_400,
      recordedBy: { firstName: 'Ana' },
      updatedBy: null,
    });
    // No user id reaches the member's phone.
    expect(JSON.stringify(mine)).not.toContain(coachAId);
  });

  /** The bug the old member route had: the second POST wiped the first's weight. */
  it('a same-day weight and then a height both survive', async () => {
    await request(server)
      .post(coachPath(clientAId, 'measurements'))
      .set(as(coachAToken))
      .send({ heightMm: 1750 })
      .expect(201);

    const row = await ctx.prisma.bodyMeasurement.findUniqueOrThrow({ where: { id: todayId } });
    expect(row.weightGrams).toBe(72_400);
    expect(row.heightMm).toBe(1750);
    expect(await ctx.prisma.bodyMeasurement.count({ where: { userId: clientAId } })).toBe(1);
  });

  it('PATCH with null clears one field; clearing every reading is a 422', async () => {
    const cleared = await request(server)
      .patch(coachPath(clientAId, `measurements/${todayId}`))
      .set(as(coachAToken))
      .send({ heightMm: null })
      .expect(200);
    expect((cleared.body as Envelope<Measurement>).data).toMatchObject({
      weightGrams: 72_400,
      heightMm: null,
    });

    const empty = await request(server)
      .patch(coachPath(clientAId, `measurements/${todayId}`))
      .set(as(coachAToken))
      .send({ weightGrams: null })
      .expect(422);
    expect((empty.body as Envelope<never>).error?.code).toBe('MEASUREMENT_EMPTY');

    const row = await ctx.prisma.bodyMeasurement.findUniqueOrThrow({ where: { id: todayId } });
    expect(row.weightGrams).toBe(72_400);
  });

  /** These two were reachable from user input as a bare 500. */
  it('refuses a notes-only reading and a flat goal with named 422s, not 500s', async () => {
    const notesOnly = await request(server)
      .post(coachPath(clientAId, 'measurements'))
      .set(as(coachAToken))
      .send({ notes: 'felt strong', businessDate: '2026-01-20' })
      .expect(422);
    expect((notesOnly.body as Envelope<never>).error?.code).toBe('MEASUREMENT_EMPTY');

    const flat = await request(server)
      .post(coachPath(clientAId, 'goals'))
      .set(as(coachAToken))
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Stay', unit: 'kg', startHundredths: 7000, targetHundredths: 7000 })
      .expect(422);
    expect((flat.body as Envelope<never>).error?.code).toBe('GOAL_TARGET_EQUALS_START');
  });

  /**
   * THE IDENTICAL 404. Five different reasons a coach cannot reach a member,
   * one response body. Anything that differed — a code, a message, a status —
   * would tell the caller which ids exist and who coaches whom.
   */
  it('answers every way of "not my member" with the identical 404 body', async () => {
    const endedAssignment = await assign(coachAId, clientBId);
    await request(server)
      .delete(`/api/v1/coach-assignments/${endedAssignment}`)
      .set(as(adminToken))
      .expect(200);

    const attempts: Array<[string, string, string]> = [
      ['COACH_B, who is not assigned', coachBToken, clientAId],
      ['a member id that does not exist', coachAToken, NOBODY],
      ['a soft-deleted member still actively assigned', coachAToken, deletedId],
      ["the coach's own id", coachAToken, coachAId],
      ['a member whose assignment has ended', coachAToken, clientBId],
    ];

    const reads: unknown[] = [];
    const writes: unknown[] = [];
    for (const [why, token, memberId] of attempts) {
      const read = await request(server).get(coachPath(memberId, 'progress')).set(as(token));
      expect({ why, status: read.status }).toEqual({ why, status: 404 });
      reads.push(read.body);

      const write = await request(server)
        .post(coachPath(memberId, 'measurements'))
        .set(as(token))
        .send({ weightGrams: 70_000 });
      expect({ why, status: write.status }).toEqual({ why, status: 404 });
      writes.push(write.body);
    }

    expect(reads[0]).toEqual({
      success: false,
      error: { code: 'MEMBER_NOT_FOUND', message: 'Member not found' },
    });
    for (const body of [...reads, ...writes]) expect(body).toEqual(reads[0]);

    // And nothing was written anywhere by any of them.
    expect(
      await ctx.prisma.bodyMeasurement.count({
        where: { userId: { in: [clientBId, deletedId, coachAId] } },
      }),
    ).toBe(0);
  });

  it('refuses ADMIN, FRONT_DESK and CLIENT on the coach routes with 403', async () => {
    for (const token of [adminToken, frontDeskToken, clientAToken]) {
      await request(server).get(coachPath(clientAId, 'progress')).set(as(token)).expect(403);
      await request(server)
        .post(coachPath(clientAId, 'measurements'))
        .set(as(token))
        .send({ weightGrams: 70_000 })
        .expect(403);
    }
  });

  /** D1: the assignment does not open the route — the COACH grant does. */
  it('refuses an ADMIN who is assigned as the member’s coach (D1)', async () => {
    const adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    await assign(adminId, clientBId);
    try {
      await request(server).get(coachPath(clientBId, 'progress')).set(as(adminToken)).expect(403);
    } finally {
      const active = await ctx.prisma.coachAssignment.findUniqueOrThrow({
        where: { activeMemberId: clientBId },
      });
      await request(server)
        .delete(`/api/v1/coach-assignments/${active.id}`)
        .set(as(adminToken))
        .expect(200);
    }
  });

  it('COACH_A reads the drill-down: the member card and their progress', async () => {
    const res = await request(server)
      .get(coachPath(clientAId, 'progress'))
      .set(as(coachAToken))
      .expect(200);
    const view = (res.body as Envelope<CoachView>).data!;
    expect(view.member.id).toBe(clientAId);
    expect(view.measurements.map((m) => m.id)).toEqual([todayId]);
  });

  let goalId: string;

  it('manages goals: add, set the current value, mark done — each attributed', async () => {
    const created = await request(server)
      .post(coachPath(clientAId, 'goals'))
      .set(as(coachAToken))
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Bench', unit: 'kg', startHundredths: 6000, targetHundredths: 10_000 })
      .expect(201);
    const goal = (created.body as Envelope<Goal>).data!;
    goalId = goal.id;
    expect(goal.recordedBy).toEqual({ firstName: 'Ana' });

    await request(server)
      .patch(coachPath(clientAId, `goals/${goalId}`))
      .set(as(coachAToken))
      .send({ currentHundredths: 8000, achieved: true })
      .expect(200);

    const mine = await myProgress();
    expect(mine.goals[0]).toMatchObject({ id: goalId, currentHundredths: 8000 });
  });

  /**
   * Reassignment. The old coach loses the member on the next request; the new
   * one can correct what the old one recorded; and the member sees both names.
   */
  it('after reassignment to COACH_B, recordedBy stays Ana and updatedBy becomes Ben', async () => {
    await assign(coachBId, clientAId);

    const lost = await request(server)
      .get(coachPath(clientAId, 'progress'))
      .set(as(coachAToken))
      .expect(404);
    expect((lost.body as Envelope<never>).error?.code).toBe('MEMBER_NOT_FOUND');

    await request(server)
      .patch(coachPath(clientAId, `measurements/${todayId}`))
      .set(as(coachBToken))
      .send({ weightGrams: 72_100 })
      .expect(200);

    const mine = await myProgress();
    expect(mine.coach).toEqual({ firstName: 'Ben', lastName: 'Cruz' });
    expect(mine.measurements[0]).toMatchObject({
      weightGrams: 72_100,
      recordedBy: { firstName: 'Ana' },
      updatedBy: { firstName: 'Ben' },
    });

    // The correction is audited — by name of field, never by value. (COACH_A's
    // earlier clear of the height is its own entry, under COACH_A.)
    const entries = await ctx.prisma.auditLog.findMany({
      where: { action: 'PROGRESS_MEASUREMENT_CORRECTED', actorId: coachBId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorId: coachBId,
      actorRole: 'COACH',
      subjectType: 'BodyMeasurement',
      subjectId: todayId,
    });
    expect(entries[0].details).toMatchObject({ memberId: clientAId, fields: ['weightGrams'] });
    const text = JSON.stringify(entries[0]);
    expect(text).not.toContain('72100');
    expect(text).not.toContain('72400');
  });

  /**
   * D5: the member's old write routes answer 403 with a sentence, for every
   * body — including one the old DTO would have rejected with a 400 — and
   * write nothing.
   */
  it('refuses CLIENT on every /me progress write with 403 PROGRESS_RECORDED_BY_COACH', async () => {
    const before = {
      measurements: await ctx.prisma.bodyMeasurement.count(),
      goals: await ctx.prisma.memberGoal.count(),
    };

    // Built lazily, one at a time: supertest binds the server per request and
    // closes it when that request ends, so requests created up front refuse.
    const attempts: Array<() => request.Test> = [
      () => request(server).post('/api/v1/me/measurements').send({ weightGrams: 70_000 }),
      () => request(server).post('/api/v1/me/measurements').send({ bogus: true }),
      () => request(server).delete(`/api/v1/me/measurements/${todayId}`),
      () => request(server).delete('/api/v1/me/measurements/not-a-uuid'),
      () =>
        request(server)
          .post('/api/v1/me/goals')
          .send({ name: 'Mine', unit: 'kg', startHundredths: 1, targetHundredths: 2 }),
      () => request(server).patch(`/api/v1/me/goals/${goalId}`).send({ achieved: false }),
      () => request(server).delete(`/api/v1/me/goals/${goalId}`),
    ];

    for (const attempt of attempts) {
      const res = await attempt().set(as(clientAToken)).expect(403);
      expect((res.body as Envelope<never>).error?.code).toBe('PROGRESS_RECORDED_BY_COACH');
    }

    expect(await ctx.prisma.bodyMeasurement.count()).toBe(before.measurements);
    expect(await ctx.prisma.memberGoal.count()).toBe(before.goals);
    const goal = await ctx.prisma.memberGoal.findUniqueOrThrow({ where: { id: goalId } });
    expect(goal.achievedAt).not.toBeNull();
  });

  describe('a self-recorded row, from before coaches recorded (D2)', () => {
    let selfMeasurementId: string;
    let selfGoalId: string;

    beforeAll(async () => {
      // Inserted raw, exactly as main's old member route left them: no recorder.
      const [measurement] = await ctx.prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "BodyMeasurement" (id, "userId", "businessDate", "weightGrams", "updatedAt")
         VALUES (gen_random_uuid(), '${clientAId}', '2026-01-10', 88800, now()) RETURNING id`,
      );
      selfMeasurementId = measurement.id;
      const [goal] = await ctx.prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "MemberGoal" (id, "userId", name, unit, "startHundredths", "currentHundredths", "targetHundredths", "updatedAt")
         VALUES (gen_random_uuid(), '${clientAId}', 'Run 5k', 'km', 100, 300, 500, now()) RETURNING id`,
      );
      selfGoalId = goal.id;
    });

    it('is labelled self-recorded (null) to the member', async () => {
      const mine = await myProgress();
      const self = mine.measurements.find((m) => m.id === selfMeasurementId);
      expect(self).toMatchObject({ recordedBy: null, updatedBy: null });
      expect(mine.goals.find((g) => g.id === selfGoalId)).toMatchObject({ recordedBy: null });
    });

    it('refuses a coach POST on its day and a coach PATCH with 409', async () => {
      const post = await request(server)
        .post(coachPath(clientAId, 'measurements'))
        .set(as(coachBToken))
        .send({ weightGrams: 80_000, businessDate: '2026-01-10' })
        .expect(409);
      expect((post.body as Envelope<never>).error?.code).toBe('PROGRESS_SELF_RECORDED');

      const patch = await request(server)
        .patch(coachPath(clientAId, `measurements/${selfMeasurementId}`))
        .set(as(coachBToken))
        .send({ weightGrams: 80_000 })
        .expect(409);
      expect((patch.body as Envelope<never>).error?.code).toBe('PROGRESS_SELF_RECORDED');

      const goal = await request(server)
        .patch(coachPath(clientAId, `goals/${selfGoalId}`))
        .set(as(coachBToken))
        .send({ currentHundredths: 400 })
        .expect(409);
      expect((goal.body as Envelope<never>).error?.code).toBe('PROGRESS_SELF_RECORDED');

      const row = await ctx.prisma.bodyMeasurement.findUniqueOrThrow({
        where: { id: selfMeasurementId },
      });
      expect(row).toMatchObject({ weightGrams: 88_800, recordedById: null, updatedById: null });
    });

    it('lets a coach DELETE it: 200 JSON {id}, and an audit row with no body values', async () => {
      const res = await request(server)
        .delete(coachPath(clientAId, `measurements/${selfMeasurementId}`))
        .set(as(coachBToken))
        .expect(200)
        .expect('Content-Type', /json/);
      expect(res.body).toEqual({ success: true, data: { id: selfMeasurementId } });

      const entry = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'PROGRESS_MEASUREMENT_DELETED', subjectId: selfMeasurementId },
      });
      expect(entry).toMatchObject({ actorId: coachBId, actorRole: 'COACH' });
      expect(entry.details).toEqual({
        memberId: clientAId,
        businessDate: '2026-01-10',
        selfRecorded: true,
        fields: ['weightGrams'],
      });
      expect(JSON.stringify(entry)).not.toContain('88800');

      const goal = await request(server)
        .delete(coachPath(clientAId, `goals/${selfGoalId}`))
        .set(as(coachBToken))
        .expect(200)
        .expect('Content-Type', /json/);
      expect(goal.body).toEqual({ success: true, data: { id: selfGoalId } });

      const goalEntry = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'PROGRESS_GOAL_DELETED', subjectId: selfGoalId },
      });
      expect(goalEntry).toMatchObject({ actorRole: 'COACH', subjectLabel: 'Run 5k' });
      expect(goalEntry.details).toEqual({ memberId: clientAId, selfRecorded: true });
    });
  });

  it('every coach DELETE answers 200 with JSON, never 204', async () => {
    const measurement = await request(server)
      .delete(coachPath(clientAId, `measurements/${todayId}`))
      .set(as(coachBToken))
      .expect(200)
      .expect('Content-Type', /json/);
    expect(measurement.body).toEqual({ success: true, data: { id: todayId } });

    const goal = await request(server)
      .delete(coachPath(clientAId, `goals/${goalId}`))
      .set(as(coachBToken))
      .expect(200)
      .expect('Content-Type', /json/);
    expect(goal.body).toEqual({ success: true, data: { id: goalId } });

    const second = await request(server)
      .delete(coachPath(clientAId, `goals/${goalId}`))
      .set(as(coachBToken))
      .expect(404);
    expect((second.body as Envelope<never>).success).toBe(false);
  });

  /** DEV is the documented superuser bypass: ALL, so no assignment is needed. */
  it('lets DEV record for a member nobody coaches', async () => {
    expect(await ctx.prisma.coachAssignment.count({ where: { activeMemberId: clientBId } })).toBe(
      0,
    );

    await request(server)
      .post(coachPath(clientBId, 'measurements'))
      .set(as(devToken))
      .send({ weightGrams: 65_000 })
      .expect(201);

    expect(await ctx.prisma.bodyMeasurement.count({ where: { userId: clientBId } })).toBe(1);
  });
});
