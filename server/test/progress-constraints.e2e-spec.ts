import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

const MEMBER_SUPABASE_ID = '40000000-0000-4000-8000-0000000000a1';
const COACH_SUPABASE_ID = '40000000-0000-4000-8000-0000000000c1';
const OTHER_COACH_SUPABASE_ID = '40000000-0000-4000-8000-0000000000c2';

/**
 * The coach-recorded progress columns, asserted at the DATABASE.
 *
 * Every rule here lives only in hand-written migration SQL
 * (20260926000100_progress_recorded_by): a `db push` or a regenerated
 * migration would drop it silently while every service test kept passing.
 * So: the exact CHECK name lists, each new predicate, the delete action of
 * every foreign key, and one raw insert per rule — each violating at most one
 * constraint, so Postgres names the one under test — plus positive controls.
 */
describe('CHECK constraints — coach-recorded progress (e2e)', () => {
  let ctx: TestApp;
  let memberId: string;
  let coachId: string;
  let otherCoachId: string;

  const sqlId = (value: string | null): string => (value === null ? 'NULL' : `'${value}'`);

  const insertMeasurement = (values: {
    recordedById: string | null;
    updatedById: string | null;
    day?: string;
  }): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "BodyMeasurement" (id, "userId", "businessDate", "weightGrams", "recordedById", "updatedById", "updatedAt")
       VALUES (gen_random_uuid(), '${memberId}', '${values.day ?? '2026-09-01'}', 72400,
               ${sqlId(values.recordedById)}, ${sqlId(values.updatedById)}, now())`,
    );

  const insertGoal = (values: {
    recordedById: string | null;
    updatedById: string | null;
  }): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "MemberGoal" (id, "userId", name, unit, "startHundredths", "currentHundredths", "targetHundredths", "recordedById", "updatedById", "updatedAt")
       VALUES (gen_random_uuid(), '${memberId}', 'Bench', 'kg', 6000, 6000, 10000,
               ${sqlId(values.recordedById)}, ${sqlId(values.updatedById)}, now())`,
    );

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);

    await ctx.fixture.tokenFor('CLIENT', { supabaseId: MEMBER_SUPABASE_ID });
    await ctx.fixture.tokenFor('COACH', { supabaseId: COACH_SUPABASE_ID });
    await ctx.fixture.tokenFor('COACH', { supabaseId: OTHER_COACH_SUPABASE_ID });
    memberId = await ctx.fixture.userIdFor(MEMBER_SUPABASE_ID);
    coachId = await ctx.fixture.userIdFor(COACH_SUPABASE_ID);
    otherCoachId = await ctx.fixture.userIdFor(OTHER_COACH_SUPABASE_ID);
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "BodyMeasurement"');
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "MemberGoal"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('presence', () => {
    const checksOn = async (table: string): Promise<string[]> => {
      const rows = await ctx.prisma.$queryRawUnsafe<Array<{ conname: string }>>(
        `SELECT conname FROM pg_constraint WHERE conrelid = '"${table}"'::regclass AND contype = 'c'`,
      );
      return rows.map((row) => row.conname).sort();
    };

    const definitionOf = async (name: string): Promise<string> => {
      const rows = await ctx.prisma.$queryRaw<Array<{ def: string }>>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}
      `;
      expect(rows).toHaveLength(1);
      return rows[0].def;
    };

    /** An EXACT set, not a subset: `toContain` would pass a stripped schema. */
    it('carries every BodyMeasurement CHECK', async () => {
      expect(await checksOn('BodyMeasurement')).toEqual([
        'BodyMeasurement_bodyfat_sane',
        'BodyMeasurement_height_sane',
        'BodyMeasurement_not_empty',
        'BodyMeasurement_recorder_not_member',
        'BodyMeasurement_updater_shape',
        'BodyMeasurement_weight_sane',
      ]);
    });

    it('carries every MemberGoal CHECK', async () => {
      expect(await checksOn('MemberGoal')).toEqual([
        'MemberGoal_name_sane',
        'MemberGoal_recorder_not_member',
        'MemberGoal_target_differs',
        'MemberGoal_unit_sane',
        'MemberGoal_updater_shape',
      ]);
    });

    /** The predicates, not just the names — a renamed-but-wrong CHECK passes a name test. */
    it('defines "recorder is never the member" and "no updater without a recorder"', async () => {
      for (const table of ['BodyMeasurement', 'MemberGoal']) {
        const recorder = await definitionOf(`${table}_recorder_not_member`);
        expect(recorder).toContain('"recordedById" IS NULL');
        expect(recorder).toContain('"recordedById" <> "userId"');

        const updater = await definitionOf(`${table}_updater_shape`);
        expect(updater).toContain('"updatedById" IS NULL');
        expect(updater).toContain('"recordedById" IS NOT NULL');
      }
    });

    /**
     * 'r' = RESTRICT: a coach named on a member's record cannot be hard-deleted
     * from under it. 'c' = CASCADE: the member's own body data goes with them.
     */
    it('restricts the four recorder/updater FKs and keeps the member FKs cascading', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
        SELECT conname, confdeltype FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid IN ('"BodyMeasurement"'::regclass, '"MemberGoal"'::regclass)
        ORDER BY conname
      `;

      expect(rows).toEqual([
        { conname: 'BodyMeasurement_recordedById_fkey', confdeltype: 'r' },
        { conname: 'BodyMeasurement_updatedById_fkey', confdeltype: 'r' },
        { conname: 'BodyMeasurement_userId_fkey', confdeltype: 'c' },
        { conname: 'MemberGoal_recordedById_fkey', confdeltype: 'r' },
        { conname: 'MemberGoal_updatedById_fkey', confdeltype: 'r' },
        { conname: 'MemberGoal_userId_fkey', confdeltype: 'c' },
      ]);
    });

    it('adds the three progress audit actions to the enum', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ value: string }>>`
        SELECT unnest(enum_range(NULL::"AuditAction"))::text AS value
      `;
      const values = rows.map((row) => row.value);
      expect(values).toEqual(
        expect.arrayContaining([
          'PROGRESS_MEASUREMENT_CORRECTED',
          'PROGRESS_MEASUREMENT_DELETED',
          'PROGRESS_GOAL_DELETED',
        ]),
      );
    });
  });

  describe('BodyMeasurement', () => {
    it('accepts a self-recorded row: no recorder, no updater (positive control)', async () => {
      await expect(insertMeasurement({ recordedById: null, updatedById: null })).resolves.toBe(1);
    });

    it('accepts a coach-recorded row another coach corrected (positive control)', async () => {
      await expect(
        insertMeasurement({ recordedById: coachId, updatedById: otherCoachId }),
      ).resolves.toBe(1);
    });

    it('rejects the member as their own recorder — BodyMeasurement_recorder_not_member', async () => {
      await expect(
        insertMeasurement({ recordedById: memberId, updatedById: null }),
      ).rejects.toThrow(/BodyMeasurement_recorder_not_member/);
    });

    it('rejects an updater on a self-recorded row — BodyMeasurement_updater_shape', async () => {
      await expect(insertMeasurement({ recordedById: null, updatedById: coachId })).rejects.toThrow(
        /BodyMeasurement_updater_shape/,
      );
    });

    it('refuses to hard-delete a coach who recorded a reading', async () => {
      await insertMeasurement({ recordedById: coachId, updatedById: null });
      await expect(
        ctx.prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = '${coachId}'`),
      ).rejects.toThrow(/BodyMeasurement_recordedById_fkey/);
    });
  });

  describe('MemberGoal', () => {
    it('accepts a self-recorded goal and a coach-recorded one (positive controls)', async () => {
      await expect(insertGoal({ recordedById: null, updatedById: null })).resolves.toBe(1);
      await expect(insertGoal({ recordedById: coachId, updatedById: coachId })).resolves.toBe(1);
    });

    it('rejects the member as their own recorder — MemberGoal_recorder_not_member', async () => {
      await expect(insertGoal({ recordedById: memberId, updatedById: null })).rejects.toThrow(
        /MemberGoal_recorder_not_member/,
      );
    });

    it('rejects an updater on a self-recorded goal — MemberGoal_updater_shape', async () => {
      await expect(insertGoal({ recordedById: null, updatedById: coachId })).rejects.toThrow(
        /MemberGoal_updater_shape/,
      );
    });

    it('refuses to hard-delete a coach who last updated a goal', async () => {
      await insertGoal({ recordedById: otherCoachId, updatedById: coachId });
      await expect(
        ctx.prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = '${coachId}'`),
      ).rejects.toThrow(/MemberGoal_updatedById_fkey/);
    });
  });
});
