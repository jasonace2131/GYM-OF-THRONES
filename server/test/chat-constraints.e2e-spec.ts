import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

const MEMBER_SUPABASE_ID = '50000000-0000-4000-8000-0000000000a1';
const COACH_SUPABASE_ID = '50000000-0000-4000-8000-0000000000c1';

/**
 * The coach-tools tables, asserted at the DATABASE (feat/coach-tools).
 *
 * Every rule here lives only in hand-written migration SQL
 * (20260929000100_chat_and_workout_plans, 20260929000200_realtime_private_channels):
 * a `db push` or a regenerated migration would drop it silently while every
 * service test kept passing. So: the exact CHECK names and their PREDICATES,
 * the delete action of every foreign key, the unique keys, RLS, the enum
 * values, one raw insert per rule — and the realtime policy migration being a
 * no-op on plain Postgres.
 */
describe('CHECK constraints — chat and workout plans (e2e)', () => {
  let ctx: TestApp;
  let memberId: string;
  let coachId: string;

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

  const insertThread = (coach: string, member: string): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "ChatThread" (id, "coachId", "memberId") VALUES (gen_random_uuid(), '${coach}', '${member}')`,
    );

  const threadId = async (): Promise<string> => {
    const rows = await ctx.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "ChatThread" WHERE "coachId" = '${coachId}' AND "memberId" = '${memberId}'`,
    );
    return rows[0].id;
  };

  const insertMessage = async (body: string): Promise<number> =>
    ctx.prisma.$executeRaw`
      INSERT INTO "ChatMessage" (id, "threadId", "senderId", body)
      VALUES (gen_random_uuid(), ${await threadId()}::uuid, ${coachId}::uuid, ${body})
    `;

  const insertPlan = (body: string, author: string): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "WorkoutPlan" (id, "memberId", "coachId", body, "updatedAt", "updatedById")
       VALUES (gen_random_uuid(), '${memberId}', '${author}', '${body}'::jsonb, now(), '${author}')`,
    );

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: MEMBER_SUPABASE_ID });
    await ctx.fixture.tokenFor('COACH', { supabaseId: COACH_SUPABASE_ID });
    memberId = await ctx.fixture.userIdFor(MEMBER_SUPABASE_ID);
    coachId = await ctx.fixture.userIdFor(COACH_SUPABASE_ID);
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "ChatReadState"');
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "ChatMessage"');
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "ChatThread"');
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "WorkoutPlan"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('presence', () => {
    it('names exactly the CHECKs the migration wrote, on each table', async () => {
      expect(await checksOn('ChatThread')).toEqual(['ChatThread_distinct_parties']);
      expect(await checksOn('ChatMessage')).toEqual(['ChatMessage_body_length']);
      expect(await checksOn('ChatReadState')).toEqual([]);
      expect(await checksOn('WorkoutPlan')).toEqual([
        'WorkoutPlan_author_not_member',
        'WorkoutPlan_body_shape',
      ]);
    });

    it('asserts each PREDICATE, not just the name', async () => {
      expect(await definitionOf('ChatThread_distinct_parties')).toBe(
        'CHECK (("coachId" <> "memberId"))',
      );
      expect(await definitionOf('ChatMessage_body_length')).toBe(
        "CHECK (((char_length(btrim(body, ' \t\r\n'::text)) >= 1) AND (char_length(body) <= 2000)))",
      );
      expect(await definitionOf('WorkoutPlan_author_not_member')).toBe(
        'CHECK ((("coachId" <> "memberId") AND ("updatedById" <> "memberId")))',
      );
      expect(await definitionOf('WorkoutPlan_body_shape')).toBe(
        "CHECK (((jsonb_typeof(body) = 'object'::text) AND COALESCE((jsonb_typeof((body -> 'days'::text)) = 'array'::text), false)))",
      );
    });

    it('makes every foreign key RESTRICT', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
        SELECT conname, confdeltype::text AS confdeltype FROM pg_constraint
         WHERE contype = 'f'
           AND conrelid IN ('"ChatThread"'::regclass, '"ChatMessage"'::regclass,
                            '"ChatReadState"'::regclass, '"WorkoutPlan"'::regclass)
         ORDER BY conname
      `;
      expect(rows).toEqual([
        { conname: 'ChatMessage_senderId_fkey', confdeltype: 'r' },
        { conname: 'ChatMessage_threadId_fkey', confdeltype: 'r' },
        { conname: 'ChatReadState_threadId_fkey', confdeltype: 'r' },
        { conname: 'ChatReadState_userId_fkey', confdeltype: 'r' },
        { conname: 'ChatThread_coachId_fkey', confdeltype: 'r' },
        { conname: 'ChatThread_memberId_fkey', confdeltype: 'r' },
        { conname: 'WorkoutPlan_coachId_fkey', confdeltype: 'r' },
        { conname: 'WorkoutPlan_memberId_fkey', confdeltype: 'r' },
        { conname: 'WorkoutPlan_updatedById_fkey', confdeltype: 'r' },
      ]);
    });

    it('has one thread per pair, one plan per member, and the page index', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename IN ('ChatThread', 'ChatMessage', 'WorkoutPlan')
         ORDER BY indexname
      `;
      const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));
      expect(byName.get('ChatThread_coachId_memberId_key')).toMatch(
        /CREATE UNIQUE INDEX .* USING btree \("coachId", "memberId"\)/,
      );
      expect(byName.get('WorkoutPlan_memberId_key')).toMatch(
        /CREATE UNIQUE INDEX .* USING btree \("memberId"\)/,
      );
      expect(byName.get('ChatMessage_threadId_createdAt_idx')).toMatch(
        /USING btree \("threadId", "createdAt"\)/,
      );
    });

    it('locks all four tables with row-level security', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
        SELECT relname, relrowsecurity FROM pg_class
         WHERE relname IN ('ChatThread', 'ChatMessage', 'ChatReadState', 'WorkoutPlan')
         ORDER BY relname
      `;
      expect(rows).toEqual([
        { relname: 'ChatMessage', relrowsecurity: true },
        { relname: 'ChatReadState', relrowsecurity: true },
        { relname: 'ChatThread', relrowsecurity: true },
        { relname: 'WorkoutPlan', relrowsecurity: true },
      ]);
    });

    it('adds the three coach-tools audit actions', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ value: string }>>`
        SELECT unnest(enum_range(NULL::"AuditAction"))::text AS value
      `;
      expect(rows.map((row) => row.value)).toEqual(
        expect.arrayContaining([
          'CHAT_THREAD_REVIEWED',
          'CHAT_MESSAGE_DELETED',
          'WORKOUT_PLAN_SAVED',
        ]),
      );
    });

    /**
     * The realtime policy migration must be a GUARDED NO-OP here: this database
     * has no `realtime` or `auth` schema. It applied (the harness got this far)
     * and created nothing.
     */
    it('applied the realtime policy migration as a no-op on plain Postgres', async () => {
      const [applied] = await ctx.prisma.$queryRaw<Array<{ done: boolean }>>`
        SELECT finished_at IS NOT NULL AND rolled_back_at IS NULL AS done
          FROM _prisma_migrations
         WHERE migration_name = '20260929000200_realtime_private_channels'
      `;
      expect(applied?.done).toBe(true);

      const [probe] = await ctx.prisma.$queryRaw<Array<{ table: string | null; policies: number }>>`
        SELECT to_regclass('realtime.messages')::text AS "table",
               (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'realtime') AS policies
      `;
      expect(probe).toEqual({ table: null, policies: 0 });
    });
  });

  describe('ChatThread', () => {
    it('accepts a coach-member pair (positive control)', async () => {
      await expect(insertThread(coachId, memberId)).resolves.toBe(1);
    });

    it('rejects a second thread for the same pair', async () => {
      await insertThread(coachId, memberId);
      await expect(insertThread(coachId, memberId)).rejects.toThrow(
        /23505[\s\S]*coachId[\s\S]*memberId/,
      );
    });

    it('rejects a thread with oneself — ChatThread_distinct_parties', async () => {
      await expect(insertThread(coachId, coachId)).rejects.toThrow(/ChatThread_distinct_parties/);
    });
  });

  describe('ChatMessage', () => {
    beforeEach(async () => {
      await insertThread(coachId, memberId);
    });

    it('accepts 1 and 2000 characters (positive controls)', async () => {
      await expect(insertMessage('k')).resolves.toBe(1);
      await expect(insertMessage('x'.repeat(2000))).resolves.toBe(1);
    });

    it('rejects an empty, a blank and a 2001-character body — ChatMessage_body_length', async () => {
      for (const body of ['', '   \n  ', 'x'.repeat(2001)]) {
        await expect(insertMessage(body)).rejects.toThrow(/ChatMessage_body_length/);
      }
    });
  });

  describe('WorkoutPlan', () => {
    const PLAN = '{"summary":"s","days":[]}';

    it('accepts a coach-written object with a days array (positive control)', async () => {
      await expect(insertPlan(PLAN, coachId)).resolves.toBe(1);
    });

    it('rejects a second plan for the same member', async () => {
      await insertPlan(PLAN, coachId);
      await expect(insertPlan(PLAN, coachId)).rejects.toThrow(/23505[\s\S]*memberId/);
    });

    it('rejects a plan the member wrote for themselves — WorkoutPlan_author_not_member', async () => {
      await expect(insertPlan(PLAN, memberId)).rejects.toThrow(/WorkoutPlan_author_not_member/);
    });

    it('rejects a body that is not an object with days — WorkoutPlan_body_shape', async () => {
      for (const body of ['[]', '"plan"', '{"summary":"s"}', '{"days":{}}']) {
        await expect(insertPlan(body, coachId)).rejects.toThrow(/WorkoutPlan_body_shape/);
      }
    });
  });
});
