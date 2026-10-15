import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

const MEMBER_SUPABASE_ID = '60000000-0000-4000-8000-0000000000a1';
const OTHER_SUPABASE_ID = '60000000-0000-4000-8000-0000000000b1';

/**
 * The member workout planner's tables, asserted at the DATABASE
 * (feat/member-workouts, migration 20260930000000_member_workouts).
 *
 * Every rule here lives only in hand-written migration SQL: a `db push` or a
 * regenerated migration would drop it silently while every service test kept
 * passing. So: the exact CHECK names and their PREDICATES, the one-active
 * partial unique index and its WHERE, the delete action of every foreign key,
 * RLS enabled with no policies, the six enums, and one raw insert per rule.
 */
describe('CHECK constraints — member workouts (e2e)', () => {
  let ctx: TestApp;
  let memberId: string;
  let otherId: string;

  const TABLES = ['MemberWorkoutPlan', 'MemberWorkoutDraft', 'WorkoutAiQuota', 'ExerciseGuide'];

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

  const PLAN_BODY = '{"summary":"s","days":[],"guidance":[]}';

  /** One plan row with every column defaulted to a valid value; `over` is raw SQL per column. */
  const insertPlan = (over: Record<string, string> = {}, member = memberId): Promise<number> => {
    const columns: Record<string, string> = {
      id: 'gen_random_uuid()',
      '"memberId"': `'${member}'`,
      name: `'Push pull'`,
      goal: `'MUSCLE'`,
      '"goalNotes"': 'NULL',
      experience: `'SOME'`,
      weekdays: 'ARRAY[1,3]::smallint[]',
      '"sessionMinutes"': '45',
      '"timeOfDay"': `'EVENING'`,
      '"healthFlag"': 'false',
      '"easyOn"': `ARRAY[]::"WorkoutEasyOn"[]`,
      '"useMeasurements"': 'true',
      '"useAttendance"': 'true',
      '"useBookings"': 'true',
      body: `'${PLAN_BODY}'::jsonb`,
      source: `'AI'`,
      '"isActive"': 'false',
      '"consentAt"': 'now()',
      '"updatedAt"': 'now()',
      ...over,
    };
    return ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "MemberWorkoutPlan" (${Object.keys(columns).join(', ')})
       VALUES (${Object.values(columns).join(', ')})`,
    );
  };

  const insertDraft = (intake: string, plan: string): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "MemberWorkoutDraft" ("memberId", "jobId", status, intake, plan, "consentAt", "updatedAt")
       VALUES ('${memberId}', gen_random_uuid(), 'RUNNING', '${intake}'::jsonb, '${plan}'::jsonb, now(), now())`,
    );

  const insertQuota = (used: number): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "WorkoutAiQuota" ("memberId", day, used) VALUES ('${memberId}', '2026-09-26', ${used})`,
    );

  const insertGuide = (
    slug: string,
    body = '{"steps":[],"mistake":"m","easier":"e","harder":"h"}',
  ): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "ExerciseGuide" (slug, name, body) VALUES ('${slug}', 'x', '${body}'::jsonb)`,
    );

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: MEMBER_SUPABASE_ID });
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: OTHER_SUPABASE_ID });
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
      expect(await checksOn('MemberWorkoutPlan')).toEqual([
        'MemberWorkoutPlan_body_shape',
        'MemberWorkoutPlan_easyOn_size',
        'MemberWorkoutPlan_goalNotes_length',
        'MemberWorkoutPlan_name_length',
        'MemberWorkoutPlan_sessionMinutes',
        'MemberWorkoutPlan_weekdays_shape',
      ]);
      expect(await checksOn('MemberWorkoutDraft')).toEqual(['MemberWorkoutDraft_json_shape']);
      expect(await checksOn('WorkoutAiQuota')).toEqual(['WorkoutAiQuota_used_nonnegative']);
      expect(await checksOn('ExerciseGuide')).toEqual([
        'ExerciseGuide_body_shape',
        'ExerciseGuide_slug_shape',
      ]);
    });

    it('asserts each PREDICATE, not just the name', async () => {
      expect(await definitionOf('MemberWorkoutPlan_name_length')).toBe(
        'CHECK (((char_length(btrim(name)) >= 1) AND (char_length(name) <= 60)))',
      );
      const notes = await definitionOf('MemberWorkoutPlan_goalNotes_length');
      expect(notes).toContain('"goalNotes" IS NULL');
      expect(notes).toContain('char_length(btrim("goalNotes")) >= 1');
      expect(notes).toContain('char_length("goalNotes") <= 300');

      const minutes = await definitionOf('MemberWorkoutPlan_sessionMinutes');
      expect(minutes).toMatch(/"sessionMinutes" = ANY \(ARRAY\[30, 45, 60, 75\]\)/);

      const weekdays = await definitionOf('MemberWorkoutPlan_weekdays_shape');
      expect(weekdays).toContain('weekdays <@');
      expect(weekdays).toContain(
        'ARRAY[(0)::smallint, (1)::smallint, (2)::smallint, (3)::smallint, (4)::smallint, (5)::smallint, (6)::smallint]',
      );
      expect(weekdays).toContain('cardinality(weekdays) >= 1');
      expect(weekdays).toContain('cardinality(weekdays) <= 7');

      expect(await definitionOf('MemberWorkoutPlan_easyOn_size')).toBe(
        'CHECK ((cardinality("easyOn") <= 6))',
      );
      expect(await definitionOf('MemberWorkoutPlan_body_shape')).toBe(
        "CHECK (((jsonb_typeof(body) = 'object'::text) AND COALESCE((jsonb_typeof((body -> 'days'::text)) = 'array'::text), false)))",
      );
      expect(await definitionOf('MemberWorkoutDraft_json_shape')).toBe(
        "CHECK (((jsonb_typeof(intake) = 'object'::text) AND (jsonb_typeof(plan) = 'object'::text)))",
      );
      expect(await definitionOf('WorkoutAiQuota_used_nonnegative')).toBe('CHECK ((used >= 0))');
      expect(await definitionOf('ExerciseGuide_slug_shape')).toContain("'^[a-z0-9-]{1,80}$'");
      expect(await definitionOf('ExerciseGuide_body_shape')).toBe(
        "CHECK (((jsonb_typeof(body) = 'object'::text) AND COALESCE((jsonb_typeof((body -> 'steps'::text)) = 'array'::text), false)))",
      );
    });

    /**
     * The PREDICATE, not the name: an index named right with the wrong WHERE
     * (or none) would either block every second plan or allow two active ones.
     */
    it('makes "one active plan per member" a PARTIAL unique index WHERE "isActive"', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'MemberWorkoutPlan_one_active'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toContain('CREATE UNIQUE INDEX');
      expect(rows[0].indexdef).toMatch(/USING btree \("memberId"\) WHERE "isActive"$/);
    });

    it('has the library index and the composite quota key', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename IN ('MemberWorkoutPlan', 'WorkoutAiQuota', 'MemberWorkoutDraft', 'ExerciseGuide')
         ORDER BY indexname
      `;
      const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));
      expect(byName.get('MemberWorkoutPlan_memberId_createdAt_idx')).toMatch(
        /USING btree \("memberId", "createdAt"\)/,
      );
      expect(byName.get('WorkoutAiQuota_pkey')).toMatch(/USING btree \("memberId", day\)/);
      expect(byName.get('MemberWorkoutDraft_pkey')).toMatch(/USING btree \("memberId"\)/);
      expect(byName.get('ExerciseGuide_pkey')).toMatch(/USING btree \(slug\)/);
    });

    it('makes every foreign key RESTRICT', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
        SELECT conname, confdeltype::text AS confdeltype FROM pg_constraint
         WHERE contype = 'f'
           AND conrelid IN ('"MemberWorkoutPlan"'::regclass, '"MemberWorkoutDraft"'::regclass,
                            '"WorkoutAiQuota"'::regclass, '"ExerciseGuide"'::regclass)
         ORDER BY conname
      `;
      expect(rows).toEqual([
        { conname: 'MemberWorkoutDraft_memberId_fkey', confdeltype: 'r' },
        { conname: 'MemberWorkoutPlan_memberId_fkey', confdeltype: 'r' },
        { conname: 'WorkoutAiQuota_memberId_fkey', confdeltype: 'r' },
      ]);
    });

    it('locks all four tables with row-level security and no policies', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
        SELECT relname, relrowsecurity FROM pg_class
         WHERE relname IN ('MemberWorkoutPlan', 'MemberWorkoutDraft', 'WorkoutAiQuota', 'ExerciseGuide')
         ORDER BY relname
      `;
      expect(rows).toEqual([
        { relname: 'ExerciseGuide', relrowsecurity: true },
        { relname: 'MemberWorkoutDraft', relrowsecurity: true },
        { relname: 'MemberWorkoutPlan', relrowsecurity: true },
        { relname: 'WorkoutAiQuota', relrowsecurity: true },
      ]);
      const [policies] = await ctx.prisma.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pg_policies
         WHERE tablename IN ('MemberWorkoutPlan', 'MemberWorkoutDraft', 'WorkoutAiQuota', 'ExerciseGuide')
      `;
      expect(policies.count).toBe(0);
    });

    it('creates the six enums with exactly the spec values', async () => {
      const valuesOf = async (name: string): Promise<string[]> => {
        const rows = await ctx.prisma.$queryRawUnsafe<Array<{ value: string }>>(
          `SELECT unnest(enum_range(NULL::"${name}"))::text AS value`,
        );
        return rows.map((row) => row.value);
      };
      expect(await valuesOf('WorkoutGoal')).toEqual([
        'MUSCLE',
        'FAT_LOSS',
        'STRENGTH',
        'ENDURANCE',
        'GENERAL',
        'SPORT',
      ]);
      expect(await valuesOf('WorkoutExperience')).toEqual(['NEW', 'SOME', 'EXPERIENCED']);
      expect(await valuesOf('WorkoutTimeOfDay')).toEqual(['MORNING', 'AFTERNOON', 'EVENING']);
      expect(await valuesOf('WorkoutEasyOn')).toEqual([
        'KNEES',
        'LOWER_BACK',
        'SHOULDERS',
        'WRISTS',
        'NECK',
        'HIPS',
      ]);
      expect(await valuesOf('WorkoutPlanSource')).toEqual(['AI', 'EDITED']);
      expect(await valuesOf('WorkoutDraftStatus')).toEqual(['RUNNING', 'READY', 'FAILED']);
    });
  });

  describe('MemberWorkoutPlan', () => {
    it('accepts a full row (positive control)', async () => {
      await expect(insertPlan()).resolves.toBe(1);
    });

    it('rejects an empty, blank or 61-character name — MemberWorkoutPlan_name_length', async () => {
      for (const name of [`''`, `'   '`, `'${'x'.repeat(61)}'`]) {
        await expect(insertPlan({ name })).rejects.toThrow(/MemberWorkoutPlan_name_length/);
      }
    });

    it('rejects blank or 301-character notes, accepts null — MemberWorkoutPlan_goalNotes_length', async () => {
      await expect(insertPlan({ '"goalNotes"': `'Bigger arms'` })).resolves.toBe(1);
      for (const notes of [`''`, `'  '`, `'${'x'.repeat(301)}'`]) {
        await expect(insertPlan({ '"goalNotes"': notes })).rejects.toThrow(
          /MemberWorkoutPlan_goalNotes_length/,
        );
      }
    });

    it('accepts 30/45/60/75 minutes and nothing else — MemberWorkoutPlan_sessionMinutes', async () => {
      for (const minutes of ['30', '60', '75']) {
        await expect(insertPlan({ '"sessionMinutes"': minutes })).resolves.toBe(1);
      }
      for (const minutes of ['0', '50', '90']) {
        await expect(insertPlan({ '"sessionMinutes"': minutes })).rejects.toThrow(
          /MemberWorkoutPlan_sessionMinutes/,
        );
      }
    });

    it('rejects an empty, eight-long or out-of-range weekdays list — MemberWorkoutPlan_weekdays_shape', async () => {
      await expect(insertPlan({ weekdays: 'ARRAY[0,1,2,3,4,5,6]::smallint[]' })).resolves.toBe(1);
      for (const weekdays of [
        'ARRAY[]::smallint[]',
        'ARRAY[0,1,2,3,4,5,6,0]::smallint[]',
        'ARRAY[7]::smallint[]',
        'ARRAY[-1]::smallint[]',
      ]) {
        await expect(insertPlan({ weekdays })).rejects.toThrow(/MemberWorkoutPlan_weekdays_shape/);
      }
    });

    it('rejects seven easy-on areas — MemberWorkoutPlan_easyOn_size', async () => {
      await expect(
        insertPlan({
          '"easyOn"': `ARRAY['KNEES','LOWER_BACK','SHOULDERS','WRISTS','NECK','HIPS']::"WorkoutEasyOn"[]`,
        }),
      ).resolves.toBe(1);
      await expect(
        insertPlan({
          '"easyOn"': `ARRAY['KNEES','LOWER_BACK','SHOULDERS','WRISTS','NECK','HIPS','KNEES']::"WorkoutEasyOn"[]`,
        }),
      ).rejects.toThrow(/MemberWorkoutPlan_easyOn_size/);
    });

    it('rejects a body that is not an object with days — MemberWorkoutPlan_body_shape', async () => {
      for (const body of ['[]', '"plan"', '{"summary":"s"}', '{"days":{}}']) {
        await expect(insertPlan({ body: `'${body}'::jsonb` })).rejects.toThrow(
          /MemberWorkoutPlan_body_shape/,
        );
      }
    });

    it('allows one active plan per member, many inactive — MemberWorkoutPlan_one_active', async () => {
      await expect(insertPlan({ '"isActive"': 'true' })).resolves.toBe(1);
      await expect(insertPlan({ '"isActive"': 'false' })).resolves.toBe(1);
      await expect(insertPlan({ '"isActive"': 'false' })).resolves.toBe(1);
      await expect(insertPlan({ '"isActive"': 'true' })).rejects.toThrow(/23505[\s\S]*memberId/);
      // Another member's active plan does not collide.
      await expect(insertPlan({ '"isActive"': 'true' }, otherId)).resolves.toBe(1);
    });

    it('refuses to delete a member who still has a plan (RESTRICT)', async () => {
      await insertPlan();
      await expect(
        ctx.prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = '${memberId}'`),
      ).rejects.toThrow(/MemberWorkoutPlan_memberId_fkey/);
    });
  });

  describe('MemberWorkoutDraft', () => {
    it('accepts one draft per member, and refuses a second', async () => {
      await expect(insertDraft('{}', '{"summary":null,"days":[],"guidance":null}')).resolves.toBe(
        1,
      );
      await expect(insertDraft('{}', '{}')).rejects.toThrow(/23505[\s\S]*memberId/);
    });

    it('rejects a non-object intake or plan — MemberWorkoutDraft_json_shape', async () => {
      await expect(insertDraft('[]', '{}')).rejects.toThrow(/MemberWorkoutDraft_json_shape/);
      await expect(insertDraft('{}', '"x"')).rejects.toThrow(/MemberWorkoutDraft_json_shape/);
    });
  });

  describe('WorkoutAiQuota', () => {
    it('accepts zero and eight, rejects a negative ledger — WorkoutAiQuota_used_nonnegative', async () => {
      await expect(insertQuota(0)).resolves.toBe(1);
      await expect(
        ctx.prisma.$executeRawUnsafe(
          `UPDATE "WorkoutAiQuota" SET used = 8 WHERE "memberId" = '${memberId}'`,
        ),
      ).resolves.toBe(1);
      await expect(
        ctx.prisma.$executeRawUnsafe(
          `UPDATE "WorkoutAiQuota" SET used = -1 WHERE "memberId" = '${memberId}'`,
        ),
      ).rejects.toThrow(/WorkoutAiQuota_used_nonnegative/);
    });

    it('is keyed on (memberId, day)', async () => {
      await insertQuota(1);
      await expect(insertQuota(2)).rejects.toThrow(/23505[\s\S]*memberId[\s\S]*day/);
      await expect(
        ctx.prisma.$executeRawUnsafe(
          `INSERT INTO "WorkoutAiQuota" ("memberId", day, used) VALUES ('${memberId}', '2026-09-27', 0)`,
        ),
      ).resolves.toBe(1);
    });
  });

  describe('ExerciseGuide', () => {
    it('accepts a slug and rejects anything that is not one — ExerciseGuide_slug_shape', async () => {
      await expect(insertGuide('goblet-squat')).resolves.toBe(1);
      for (const slug of ['', 'Goblet Squat', 'goblet_squat', 'a'.repeat(81)]) {
        await expect(insertGuide(slug)).rejects.toThrow(/ExerciseGuide_slug_shape/);
      }
    });

    it('rejects a body without a steps list — ExerciseGuide_body_shape', async () => {
      for (const body of ['[]', '{"mistake":"m"}', '{"steps":"a, b, c"}']) {
        await expect(insertGuide('plank', body)).rejects.toThrow(/ExerciseGuide_body_shape/);
      }
    });
  });
});
