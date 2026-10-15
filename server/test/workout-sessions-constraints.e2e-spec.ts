import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

const MEMBER_SUPABASE_ID = '61000000-0000-4000-8000-0000000000a1';
const OTHER_SUPABASE_ID = '61000000-0000-4000-8000-0000000000b1';

const SESSION_ID = '61000000-0000-4000-8000-00000000c001';
const MEMBER_PLAN_ID = '61000000-0000-4000-8000-00000000d001';
const COACH_PLAN_ID = '61000000-0000-4000-8000-00000000e001';

/**
 * Workout sessions, asserted at the DATABASE (feat/workout-sessions,
 * migration 20261001000000_workout_sessions).
 *
 * Every rule here lives only in hand-written migration SQL: a `db push` or a
 * regenerated migration would drop it silently while every service test kept
 * passing. So: the exact CHECK names and their PREDICATES, the one-open
 * partial unique index and its WHERE, the delete action of every foreign key
 * (SET NULL to both plans keeps the history), RLS enabled with no policies,
 * the two enums, and one raw insert per rule.
 */
describe('CHECK constraints — workout sessions (e2e)', () => {
  let ctx: TestApp;
  let memberId: string;
  let otherId: string;

  const TABLES = ['WorkoutSetLog', 'WorkoutSession', 'MemberWorkoutPlan', 'WorkoutPlan'];

  const definitionOf = async (name: string): Promise<string> => {
    const rows = await ctx.prisma.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}
    `;
    expect(rows).toHaveLength(1);
    return rows[0].def;
  };

  const checksOn = async (table: string): Promise<string[]> => {
    const rows = await ctx.prisma.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"${table}"'::regclass AND contype = 'c'`,
    );
    return rows.map((row) => row.conname).sort();
  };

  const exercise = (name: string) =>
    `{"name":"${name}","muscles":null,"sets":3,"reps":"10","restSeconds":90}`;
  const snapshot = (count: number): string =>
    `[${Array.from({ length: count }, (_, i) => exercise(`Exercise ${i}`)).join(',')}]`;

  /**
   * One FINISHED session with every column defaulted to a valid value (so any
   * number of them can coexist); `over` is raw SQL per column.
   */
  const insertSession = (over: Record<string, string> = {}, member = memberId): Promise<number> => {
    const columns: Record<string, string> = {
      id: 'gen_random_uuid()',
      '"memberId"': `'${member}'`,
      source: `'MEMBER_PLAN'`,
      '"memberPlanId"': 'NULL',
      '"coachPlanId"': 'NULL',
      '"planName"': `'Strength base'`,
      '"coachFirstName"': 'NULL',
      '"coachLastName"': 'NULL',
      '"dayTitle"': `'Full body A'`,
      weekday: '3',
      exercises: `'${snapshot(2)}'::jsonb`,
      '"businessDate"': `'2026-09-30'`,
      '"startedAt"': `'2026-09-30T02:00:00Z'`,
      '"finishedAt"': `'2026-09-30T03:00:00Z'`,
      feeling: 'NULL',
      '"updatedAt"': 'now()',
      ...over,
    };
    return ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "WorkoutSession" (${Object.keys(columns).join(', ')})
       VALUES (${Object.values(columns).join(', ')})`,
    );
  };

  /** One ticked set of SESSION_ID, every column valid; `over` is raw SQL per column. */
  const insertSet = (over: Record<string, string> = {}): Promise<number> => {
    const columns: Record<string, string> = {
      '"sessionId"': `'${SESSION_ID}'`,
      '"exerciseIndex"': '0',
      '"setIndex"': '0',
      '"memberId"': `'${memberId}'`,
      '"exerciseName"': `'Leg press'`,
      '"exerciseSlug"': `'leg-press'`,
      '"weightGrams"': '80000',
      reps: '10',
      '"completedAt"': 'now()',
      '"updatedAt"': 'now()',
      ...over,
    };
    return ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "WorkoutSetLog" (${Object.keys(columns).join(', ')})
       VALUES (${Object.values(columns).join(', ')})`,
    );
  };

  const insertMemberPlan = (): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "MemberWorkoutPlan" (id, "memberId", name, goal, experience, weekdays,
         "sessionMinutes", "timeOfDay", "healthFlag", "easyOn", "useMeasurements",
         "useAttendance", "useBookings", body, source, "isActive", "consentAt", "updatedAt")
       VALUES ('${MEMBER_PLAN_ID}', '${memberId}', 'Push pull', 'MUSCLE', 'SOME',
         ARRAY[1,3]::smallint[], 45, 'EVENING', false, ARRAY[]::"WorkoutEasyOn"[], true, true,
         true, '{"summary":"s","days":[],"guidance":[]}'::jsonb, 'AI', false, now(), now())`,
    );

  const insertCoachPlan = (): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "WorkoutPlan" (id, "memberId", "coachId", body, "updatedAt", "updatedById")
       VALUES ('${COACH_PLAN_ID}', '${memberId}', '${otherId}',
         '{"summary":"s","days":[]}'::jsonb, now(), '${otherId}')`,
    );

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: MEMBER_SUPABASE_ID });
    await ctx.fixture.tokenFor('COACH', { supabaseId: OTHER_SUPABASE_ID });
    memberId = await ctx.fixture.userIdFor(MEMBER_SUPABASE_ID);
    otherId = await ctx.fixture.userIdFor(OTHER_SUPABASE_ID);
  });

  afterEach(async () => {
    for (const table of TABLES) {
      await ctx.prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('presence', () => {
    it('names exactly the CHECKs the migration wrote, on each table', async () => {
      expect(await checksOn('WorkoutSession')).toEqual([
        'WorkoutSession_coachPlan_source',
        'WorkoutSession_dayTitle_length',
        'WorkoutSession_exercises_shape',
        'WorkoutSession_feeling_finished',
        'WorkoutSession_finished_after_start',
        'WorkoutSession_memberPlan_source',
        'WorkoutSession_one_plan',
        'WorkoutSession_planName_length',
        'WorkoutSession_weekday_range',
      ]);
      expect(await checksOn('WorkoutSetLog')).toEqual([
        'WorkoutSetLog_exerciseIndex_range',
        'WorkoutSetLog_exerciseSlug_shape',
        'WorkoutSetLog_reps_range',
        'WorkoutSetLog_setIndex_range',
        'WorkoutSetLog_weightGrams_range',
      ]);
    });

    it('asserts each WorkoutSession PREDICATE, not just the name', async () => {
      const onePlan = await definitionOf('WorkoutSession_one_plan');
      expect(onePlan).toContain('"memberPlanId" IS NULL');
      expect(onePlan).toContain('"coachPlanId" IS NULL');
      expect(onePlan).toContain(' OR ');

      const memberSource = await definitionOf('WorkoutSession_memberPlan_source');
      expect(memberSource).toContain('"memberPlanId" IS NULL');
      expect(memberSource).toContain(`source = 'MEMBER_PLAN'::"WorkoutSessionSource"`);

      const coachSource = await definitionOf('WorkoutSession_coachPlan_source');
      expect(coachSource).toContain('"coachPlanId" IS NULL');
      expect(coachSource).toContain(`source = 'COACH_PLAN'::"WorkoutSessionSource"`);

      const feeling = await definitionOf('WorkoutSession_feeling_finished');
      expect(feeling).toContain('feeling IS NULL');
      expect(feeling).toContain('"finishedAt" IS NOT NULL');

      const after = await definitionOf('WorkoutSession_finished_after_start');
      expect(after).toContain('"finishedAt" IS NULL');
      expect(after).toContain('"finishedAt" >= "startedAt"');

      const shape = await definitionOf('WorkoutSession_exercises_shape');
      expect(shape).toMatch(/CASE\s+WHEN/);
      expect(shape).toContain(`jsonb_typeof(exercises) = 'array'::text`);
      expect(shape).toContain('jsonb_array_length(exercises) >= 1');
      expect(shape).toContain('jsonb_array_length(exercises) <= 12');
      expect(shape).toMatch(/ELSE\s+false/);

      const weekday = await definitionOf('WorkoutSession_weekday_range');
      expect(weekday).toContain('weekday IS NULL');
      expect(weekday).toContain('weekday >= 0');
      expect(weekday).toContain('weekday <= 6');

      expect(await definitionOf('WorkoutSession_planName_length')).toBe(
        'CHECK (((char_length(btrim("planName")) >= 1) AND (char_length("planName") <= 60)))',
      );
      expect(await definitionOf('WorkoutSession_dayTitle_length')).toBe(
        'CHECK (((char_length(btrim("dayTitle")) >= 1) AND (char_length("dayTitle") <= 40)))',
      );
    });

    it('asserts each WorkoutSetLog PREDICATE, not just the name', async () => {
      const exerciseIndex = await definitionOf('WorkoutSetLog_exerciseIndex_range');
      expect(exerciseIndex).toContain('"exerciseIndex" >= 0');
      expect(exerciseIndex).toContain('"exerciseIndex" <= 11');

      const setIndex = await definitionOf('WorkoutSetLog_setIndex_range');
      expect(setIndex).toContain('"setIndex" >= 0');
      expect(setIndex).toContain('"setIndex" <= 19');

      expect(await definitionOf('WorkoutSetLog_exerciseSlug_shape')).toContain(
        "'^[a-z0-9-]{1,80}$'",
      );

      const weight = await definitionOf('WorkoutSetLog_weightGrams_range');
      expect(weight).toContain('"weightGrams" IS NULL');
      expect(weight).toContain('"weightGrams" >= 1');
      expect(weight).toContain('"weightGrams" <= 500000');

      const reps = await definitionOf('WorkoutSetLog_reps_range');
      expect(reps).toContain('reps >= 1');
      expect(reps).toContain('reps <= 200');
    });

    /**
     * The PREDICATE, not the name: an index named right with the wrong WHERE
     * (or none) would either block every second workout or allow two open ones.
     */
    it('makes "one open workout per member" a PARTIAL unique index WHERE "finishedAt" IS NULL', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'WorkoutSession_one_open'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toContain('CREATE UNIQUE INDEX');
      expect(rows[0].indexdef).toMatch(
        /USING btree \("memberId"\) WHERE \("finishedAt" IS NULL\)$/,
      );
    });

    it('has the history index, the "last time" index and the composite set key', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename IN ('WorkoutSession', 'WorkoutSetLog')
         ORDER BY indexname
      `;
      const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));
      expect(byName.get('WorkoutSession_memberId_startedAt_idx')).toMatch(
        /USING btree \("memberId", "startedAt" DESC\)/,
      );
      expect(byName.get('WorkoutSetLog_memberId_exerciseSlug_completedAt_idx')).toMatch(
        /USING btree \("memberId", "exerciseSlug", "completedAt" DESC\)/,
      );
      expect(byName.get('WorkoutSetLog_pkey')).toMatch(
        /USING btree \("sessionId", "exerciseIndex", "setIndex"\)/,
      );
      expect(byName.get('WorkoutSession_pkey')).toMatch(/USING btree \(id\)/);
    });

    it('SET NULL to both plans, CASCADE sets to their session, RESTRICT to the member', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
        SELECT conname, confdeltype::text AS confdeltype FROM pg_constraint
         WHERE contype = 'f'
           AND conrelid IN ('"WorkoutSession"'::regclass, '"WorkoutSetLog"'::regclass)
         ORDER BY conname
      `;
      expect(rows).toEqual([
        { conname: 'WorkoutSession_coachPlanId_fkey', confdeltype: 'n' },
        { conname: 'WorkoutSession_memberId_fkey', confdeltype: 'r' },
        { conname: 'WorkoutSession_memberPlanId_fkey', confdeltype: 'n' },
        { conname: 'WorkoutSetLog_memberId_fkey', confdeltype: 'r' },
        { conname: 'WorkoutSetLog_sessionId_fkey', confdeltype: 'c' },
      ]);
    });

    it('locks both tables with row-level security and no policies', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
        SELECT relname, relrowsecurity FROM pg_class
         WHERE relname IN ('WorkoutSession', 'WorkoutSetLog')
         ORDER BY relname
      `;
      expect(rows).toEqual([
        { relname: 'WorkoutSession', relrowsecurity: true },
        { relname: 'WorkoutSetLog', relrowsecurity: true },
      ]);
      const [policies] = await ctx.prisma.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pg_policies
         WHERE tablename IN ('WorkoutSession', 'WorkoutSetLog')
      `;
      expect(policies.count).toBe(0);
    });

    it('creates the two enums with exactly the spec values', async () => {
      const valuesOf = async (name: string): Promise<string[]> => {
        const rows = await ctx.prisma.$queryRawUnsafe<Array<{ value: string }>>(
          `SELECT unnest(enum_range(NULL::"${name}"))::text AS value`,
        );
        return rows.map((row) => row.value);
      };
      expect(await valuesOf('WorkoutSessionSource')).toEqual(['MEMBER_PLAN', 'COACH_PLAN']);
      expect(await valuesOf('WorkoutFeeling')).toEqual(['EASY', 'RIGHT', 'HARD']);
    });
  });

  describe('WorkoutSession', () => {
    it('accepts a finished and an open row (positive control)', async () => {
      await expect(insertSession()).resolves.toBe(1);
      await expect(insertSession({ '"finishedAt"': 'NULL' })).resolves.toBe(1);
    });

    it('allows one OPEN workout per member, many finished — WorkoutSession_one_open', async () => {
      await expect(insertSession({ '"finishedAt"': 'NULL' })).resolves.toBe(1);
      await expect(insertSession()).resolves.toBe(1);
      await expect(insertSession()).resolves.toBe(1);
      await expect(insertSession({ '"finishedAt"': 'NULL' })).rejects.toThrow(
        /23505[\s\S]*memberId/,
      );
      // Another member's open workout does not collide.
      await expect(insertSession({ '"finishedAt"': 'NULL' }, otherId)).resolves.toBe(1);
    });

    it('matches each plan link to its source — WorkoutSession_memberPlan_source / _coachPlan_source', async () => {
      await insertMemberPlan();
      await insertCoachPlan();
      await expect(insertSession({ '"memberPlanId"': `'${MEMBER_PLAN_ID}'` })).resolves.toBe(1);
      await expect(
        insertSession({ source: `'COACH_PLAN'`, '"coachPlanId"': `'${COACH_PLAN_ID}'` }),
      ).resolves.toBe(1);
      await expect(
        insertSession({ source: `'COACH_PLAN'`, '"memberPlanId"': `'${MEMBER_PLAN_ID}'` }),
      ).rejects.toThrow(/WorkoutSession_memberPlan_source/);
      await expect(insertSession({ '"coachPlanId"': `'${COACH_PLAN_ID}'` })).rejects.toThrow(
        /WorkoutSession_coachPlan_source/,
      );
    });

    it('never links both plans — WorkoutSession_one_plan (or the source rule it also breaks)', async () => {
      await insertMemberPlan();
      await insertCoachPlan();
      // Any source makes one of the two source rules fail as well; which name
      // Postgres reports is its evaluation order, so accept any of the three.
      await expect(
        insertSession({
          '"memberPlanId"': `'${MEMBER_PLAN_ID}'`,
          '"coachPlanId"': `'${COACH_PLAN_ID}'`,
        }),
      ).rejects.toThrow(/WorkoutSession_(one_plan|coachPlan_source|memberPlan_source)/);
    });

    it('has a feeling only once finished — WorkoutSession_feeling_finished', async () => {
      await expect(insertSession({ feeling: `'EASY'` })).resolves.toBe(1);
      await expect(insertSession({ '"finishedAt"': 'NULL', feeling: `'HARD'` })).rejects.toThrow(
        /WorkoutSession_feeling_finished/,
      );
    });

    it('never finishes before it started — WorkoutSession_finished_after_start', async () => {
      await expect(insertSession({ '"finishedAt"': `'2026-09-30T02:00:00Z'` })).resolves.toBe(1);
      await expect(insertSession({ '"finishedAt"': `'2026-09-30T01:59:59Z'` })).rejects.toThrow(
        /WorkoutSession_finished_after_start/,
      );
    });

    it('holds a list of 1-12 exercises — WorkoutSession_exercises_shape', async () => {
      await expect(insertSession({ exercises: `'${snapshot(12)}'::jsonb` })).resolves.toBe(1);
      for (const value of ['[]', '{}', '"x"', snapshot(13)]) {
        await expect(insertSession({ exercises: `'${value}'::jsonb` })).rejects.toThrow(
          /WorkoutSession_exercises_shape/,
        );
      }
    });

    it('keeps the weekday 0-6 or null — WorkoutSession_weekday_range', async () => {
      for (const weekday of ['NULL', '0', '6']) {
        await expect(insertSession({ weekday })).resolves.toBe(1);
      }
      for (const weekday of ['-1', '7']) {
        await expect(insertSession({ weekday })).rejects.toThrow(/WorkoutSession_weekday_range/);
      }
    });

    it('bounds the plan name and day title, never only whitespace', async () => {
      for (const name of [`''`, `'   '`, `'${'x'.repeat(61)}'`]) {
        await expect(insertSession({ '"planName"': name })).rejects.toThrow(
          /WorkoutSession_planName_length/,
        );
      }
      for (const title of [`''`, `'  '`, `'${'x'.repeat(41)}'`]) {
        await expect(insertSession({ '"dayTitle"': title })).rejects.toThrow(
          /WorkoutSession_dayTitle_length/,
        );
      }
      await expect(
        insertSession({ '"planName"': `'${'x'.repeat(60)}'`, '"dayTitle"': `'${'y'.repeat(40)}'` }),
      ).resolves.toBe(1);
    });

    it('refuses to delete a member who still has a workout (RESTRICT)', async () => {
      await insertSession();
      await expect(
        ctx.prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = '${memberId}'`),
      ).rejects.toThrow(/WorkoutSession_memberId_fkey/);
    });

    it('keeps the workout when its plan is deleted — both links SET NULL', async () => {
      await insertMemberPlan();
      await insertCoachPlan();
      await insertSession({ id: `'${SESSION_ID}'`, '"memberPlanId"': `'${MEMBER_PLAN_ID}'` });
      await insertSession({ source: `'COACH_PLAN'`, '"coachPlanId"': `'${COACH_PLAN_ID}'` });
      await insertSet();

      await ctx.prisma.$executeRawUnsafe(
        `DELETE FROM "MemberWorkoutPlan" WHERE id = '${MEMBER_PLAN_ID}'`,
      );
      await ctx.prisma.$executeRawUnsafe(`DELETE FROM "WorkoutPlan" WHERE id = '${COACH_PLAN_ID}'`);

      const rows = await ctx.prisma.$queryRawUnsafe<
        Array<{ source: string; memberPlanId: string | null; coachPlanId: string | null }>
      >(
        `SELECT source::text AS source, "memberPlanId", "coachPlanId" FROM "WorkoutSession"
          WHERE "memberId" = '${memberId}' ORDER BY source`,
      );
      expect(rows).toEqual([
        { source: 'COACH_PLAN', memberPlanId: null, coachPlanId: null },
        { source: 'MEMBER_PLAN', memberPlanId: null, coachPlanId: null },
      ]);
      // The ticks are history too.
      const [sets] = await ctx.prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM "WorkoutSetLog" WHERE "sessionId" = '${SESSION_ID}'`,
      );
      expect(sets.count).toBe(1);
    });
  });

  describe('WorkoutSetLog', () => {
    beforeEach(async () => {
      await insertSession({ id: `'${SESSION_ID}'` });
    });

    it('accepts a weighted and a bodyweight set (positive control)', async () => {
      await expect(insertSet()).resolves.toBe(1);
      await expect(insertSet({ '"setIndex"': '1', '"weightGrams"': 'NULL' })).resolves.toBe(1);
    });

    it('is keyed on (session, exercise, set) — a second tick of the same set collides', async () => {
      await insertSet();
      await expect(insertSet({ reps: '12' })).rejects.toThrow(
        /23505[\s\S]*sessionId[\s\S]*exerciseIndex[\s\S]*setIndex/,
      );
    });

    it('keeps the exercise index 0-11 — WorkoutSetLog_exerciseIndex_range', async () => {
      await expect(insertSet({ '"exerciseIndex"': '11' })).resolves.toBe(1);
      for (const index of ['-1', '12']) {
        await expect(insertSet({ '"exerciseIndex"': index })).rejects.toThrow(
          /WorkoutSetLog_exerciseIndex_range/,
        );
      }
    });

    it('keeps the set index 0-19 — WorkoutSetLog_setIndex_range', async () => {
      await expect(insertSet({ '"setIndex"': '19' })).resolves.toBe(1);
      for (const index of ['-1', '20']) {
        await expect(insertSet({ '"setIndex"': index })).rejects.toThrow(
          /WorkoutSetLog_setIndex_range/,
        );
      }
    });

    it('stores only a slug — WorkoutSetLog_exerciseSlug_shape', async () => {
      for (const slug of [`''`, `'Leg Press'`, `'leg_press'`, `'${'a'.repeat(81)}'`]) {
        await expect(insertSet({ '"exerciseSlug"': slug })).rejects.toThrow(
          /WorkoutSetLog_exerciseSlug_shape/,
        );
      }
    });

    it('weighs 1 g to 500 kg, or null — WorkoutSetLog_weightGrams_range', async () => {
      await expect(insertSet({ '"weightGrams"': '500000' })).resolves.toBe(1);
      for (const grams of ['0', '-10', '500001']) {
        await expect(insertSet({ '"setIndex"': '1', '"weightGrams"': grams })).rejects.toThrow(
          /WorkoutSetLog_weightGrams_range/,
        );
      }
    });

    it('counts 1-200 reps — WorkoutSetLog_reps_range', async () => {
      await expect(insertSet({ reps: '200' })).resolves.toBe(1);
      for (const reps of ['0', '201']) {
        await expect(insertSet({ '"setIndex"': '1', reps })).rejects.toThrow(
          /WorkoutSetLog_reps_range/,
        );
      }
    });

    it('goes with its session (CASCADE) — discarding a workout takes its ticks', async () => {
      await insertSet();
      await insertSet({ '"setIndex"': '1' });
      await ctx.prisma.$executeRawUnsafe(`DELETE FROM "WorkoutSession" WHERE id = '${SESSION_ID}'`);
      const [left] = await ctx.prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM "WorkoutSetLog"`,
      );
      expect(left.count).toBe(0);
    });

    it('refuses to delete the member a set names (RESTRICT)', async () => {
      // The set names the OTHER user, so their delete meets only this key.
      await insertSet({ '"memberId"': `'${otherId}'` });
      await expect(
        ctx.prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = '${otherId}'`),
      ).rejects.toThrow(/WorkoutSetLog_memberId_fkey/);
    });
  });
});
