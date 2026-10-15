import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

const ADMIN_SUPABASE_ID = '63000000-0000-4000-8000-0000000000a1';

/**
 * The assistant's editable instructions, asserted at the DATABASE
 * (feat/assistant-settings, migrations 20261014000000_audit_actions_assistant
 * and 20261014000100_assistant_settings).
 *
 * Every rule here lives only in hand-written migration SQL: a `db push` or a
 * regenerated migration would drop it silently while every service test kept
 * passing. So: the exact CHECK names and their predicates, the foreign key's
 * actions, RLS enabled with no policies, the two audit values, and one raw
 * insert per rule plus positive controls.
 *
 * Written 2026-10-14 under the owner's batch-E2E rule and not yet run against
 * Postgres: the predicate strings are what `pg_get_constraintdef` is expected
 * to print, modelled on member-notices-constraints, and are the first thing to
 * check if this suite fails on its first run.
 */
describe('CHECK constraints — assistant settings (e2e)', () => {
  let ctx: TestApp;
  let adminId: string;

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

  /** One row with every column valid; `over` is raw SQL per column. */
  const insert = (over: Record<string, string> = {}): Promise<number> => {
    const columns: Record<string, string> = {
      id: '1',
      instructions: `'Be brief.'`,
      '"updatedById"': `'${adminId}'`,
      '"updatedAt"': 'CURRENT_TIMESTAMP',
      ...over,
    };
    return ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "AssistantSettings" (${Object.keys(columns).join(', ')})
       VALUES (${Object.values(columns).join(', ')})`,
    );
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await ctx.fixture.tokenFor('ADMIN', { supabaseId: ADMIN_SUPABASE_ID });
    adminId = await ctx.fixture.userIdFor(ADMIN_SUPABASE_ID);
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "AssistantSettings"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('presence', () => {
    it('names exactly the CHECKs the migration wrote', async () => {
      expect(await checksOn('AssistantSettings')).toEqual([
        'AssistantSettings_instructions_sane',
        'AssistantSettings_single_row',
      ]);
    });

    it('asserts each PREDICATE, not just the name', async () => {
      expect(await definitionOf('AssistantSettings_single_row')).toBe('CHECK ((id = 1))');
      expect(await definitionOf('AssistantSettings_instructions_sane')).toBe(
        "CHECK (((char_length(btrim(instructions, ' \t\r\n'::text)) >= 1) AND (char_length(instructions) <= 6000)))",
      );
    });

    /** 'n' = SET NULL on delete, 'c' = CASCADE on update — the GymHours pattern. */
    it('forgets the editor rather than losing the instructions', async () => {
      const rows = await ctx.prisma.$queryRaw<
        Array<{ conname: string; confdeltype: string; confupdtype: string }>
      >`
        SELECT conname, confdeltype::text AS confdeltype, confupdtype::text AS confupdtype
          FROM pg_constraint
         WHERE contype = 'f' AND conrelid = '"AssistantSettings"'::regclass
      `;
      expect(rows).toEqual([
        { conname: 'AssistantSettings_updatedById_fkey', confdeltype: 'n', confupdtype: 'c' },
      ]);
    });

    it('locks the table with row-level security and no policies', async () => {
      const rows = await ctx.prisma.$queryRaw<
        Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
      >`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'AssistantSettings'
      `;
      expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: false }]);

      const [policies] = await ctx.prisma.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pg_policies WHERE tablename = 'AssistantSettings'
      `;
      expect(policies.count).toBe(0);
    });

    it('adds the two assistant audit actions', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ value: string }>>`
        SELECT unnest(enum_range(NULL::"AuditAction"))::text AS value
      `;
      expect(rows.map((row) => row.value)).toEqual(
        expect.arrayContaining(['ASSISTANT_INSTRUCTIONS_UPDATED', 'ASSISTANT_INSTRUCTIONS_RESET']),
      );
    });
  });

  describe('enforcement', () => {
    it('accepts a valid row (positive control)', async () => {
      await expect(insert()).resolves.toBe(1);
    });

    it('accepts a row whose editor is gone', async () => {
      await expect(insert({ '"updatedById"': 'NULL' })).resolves.toBe(1);
    });

    it('refuses a second row', async () => {
      await insert();
      await expect(insert({ id: '2' })).rejects.toThrow(/AssistantSettings_single_row/);
    });

    it('refuses blank instructions, tabs and line breaks included', async () => {
      await expect(insert({ instructions: `E' \\t\\r\\n '` })).rejects.toThrow(
        /AssistantSettings_instructions_sane/,
      );
    });

    it('accepts 6,000 characters and refuses 6,001', async () => {
      await expect(insert({ instructions: `repeat('a', 6001)` })).rejects.toThrow(
        /AssistantSettings_instructions_sane/,
      );
      await expect(insert({ instructions: `repeat('a', 6000)` })).resolves.toBe(1);
    });
  });
});
