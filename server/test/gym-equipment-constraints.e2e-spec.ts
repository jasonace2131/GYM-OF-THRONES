import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

/**
 * The gym equipment list, asserted at the DATABASE (owner, 2026-10-23;
 * migrations 20261023000000_gym_equipment and
 * 20261023000100_audit_action_gym_equipment).
 *
 * Every rule here lives only in hand-written migration SQL: a `db push` or a
 * regenerated migration would drop it silently while every service test kept
 * passing. So: the exact CHECK names and predicates, the lower(name) unique
 * index and its definition, RLS with no policies, the audit value, and one
 * raw insert per rule plus a positive control.
 *
 * Written 2026-10-23 under the owner's batch-E2E rule and NOT yet run against
 * Postgres: the predicate strings are what `pg_get_constraintdef` is expected
 * to print, modelled on assistant-settings-constraints, and are the first
 * thing to check if this suite fails on its first run.
 */
describe('CHECK constraints — gym equipment (e2e)', () => {
  let ctx: TestApp;

  const definitionOf = async (name: string): Promise<string> => {
    const rows = await ctx.prisma.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}
    `;
    expect(rows).toHaveLength(1);
    return rows[0].def;
  };

  const insert = (over: Record<string, string> = {}): Promise<number> => {
    const columns: Record<string, string> = {
      id: 'gen_random_uuid()',
      name: `'Dumbbells'`,
      detail: `'2-40 kg pairs'`,
      '"sortOrder"': '0',
      '"updatedAt"': 'CURRENT_TIMESTAMP',
      ...over,
    };
    return ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "GymEquipment" (${Object.keys(columns).join(', ')})
       VALUES (${Object.values(columns).join(', ')})`,
    );
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "GymEquipment"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('names exactly the CHECKs the migration wrote, with their predicates', async () => {
    const rows = await ctx.prisma.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"GymEquipment"'::regclass AND contype = 'c'`,
    );
    expect(rows.map((row) => row.conname).sort()).toEqual([
      'GymEquipment_detail_sane',
      'GymEquipment_name_sane',
      'GymEquipment_sortOrder_nonnegative',
    ]);
    expect(await definitionOf('GymEquipment_name_sane')).toBe(
      "CHECK (((char_length(btrim(name, ' \t\r\n'::text)) >= 1) AND (char_length(name) <= 80)))",
    );
    expect(await definitionOf('GymEquipment_detail_sane')).toBe(
      "CHECK (((detail IS NULL) OR ((char_length(btrim(detail, ' \t\r\n'::text)) >= 1) AND (char_length(detail) <= 120))))",
    );
    expect(await definitionOf('GymEquipment_sortOrder_nonnegative')).toBe(
      'CHECK (("sortOrder" >= 0))',
    );
  });

  it('has the case-insensitive unique index on lower(name)', async () => {
    const rows = await ctx.prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'GymEquipment_name_lower_key'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('CREATE UNIQUE INDEX');
    expect(rows[0].indexdef).toContain('lower(name)');
  });

  it('locks the table with row-level security and no policies', async () => {
    const rows = await ctx.prisma.$queryRaw<Array<{ relrowsecurity: boolean }>>`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'GymEquipment'
    `;
    expect(rows).toEqual([{ relrowsecurity: true }]);
  });

  it('adds the GYM_EQUIPMENT_CHANGED audit action', async () => {
    const rows = await ctx.prisma.$queryRaw<Array<{ value: string }>>`
      SELECT unnest(enum_range(NULL::"AuditAction"))::text AS value
    `;
    expect(rows.map((row) => row.value)).toContain('GYM_EQUIPMENT_CHANGED');
  });

  it('accepts a valid row, and a null detail', async () => {
    await expect(insert()).resolves.toBe(1);
    await expect(insert({ name: `'Bench'`, detail: 'NULL' })).resolves.toBe(1);
  });

  it('refuses a blank or long name, a blank or long detail, a negative order', async () => {
    const overrides: Record<string, string>[] = [
      { name: `E' \\t\\n'` },
      { name: `'${'x'.repeat(81)}'` },
      { detail: `'  '` },
      { detail: `'${'x'.repeat(121)}'` },
      { '"sortOrder"': '-1' },
    ];
    for (const over of overrides) {
      await expect(insert(over)).rejects.toThrow();
    }
  });

  it('refuses the same name in another case', async () => {
    await insert();
    await expect(insert({ name: `'DUMBBELLS'` })).rejects.toThrow();
  });
});
