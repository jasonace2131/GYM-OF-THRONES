import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

/**
 * The gym's edits to role grants, asserted at the DATABASE (owner, 2026-11-07;
 * migrations 20261107000000_role_permission_override and
 * 20261107000100_audit_action_role_permissions).
 *
 * The not-DEV CHECK, RLS and the audit value live only in hand-written SQL, so
 * a `db push` or a regenerated migration would drop them silently while every
 * service test kept passing.
 *
 * Written 2026-11-07 under the owner's batch-E2E rule and NOT yet run against
 * Postgres: the predicate string is what `pg_get_constraintdef` is expected to
 * print, and is the first thing to check if this suite fails on its first run.
 */
describe('CHECK constraints — role access overrides (e2e)', () => {
  let ctx: TestApp;

  const insert = async (role: string, scope: string): Promise<number> => {
    const [permission] = await ctx.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Permission" WHERE key = 'payment.void'
    `;
    return ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "RolePermissionOverride" (id, role, "permissionId", scope, "updatedAt")
       VALUES (gen_random_uuid(), '${role}', '${permission.id}', ${scope}, CURRENT_TIMESTAMP)`,
    );
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "RolePermissionOverride"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('names exactly the CHECK the migration wrote, with its predicate', async () => {
    const rows = await ctx.prisma.$queryRawUnsafe<Array<{ conname: string; def: string }>>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = '"RolePermissionOverride"'::regclass AND contype = 'c'`,
    );
    expect(rows).toEqual([
      { conname: 'RolePermissionOverride_not_dev', def: `CHECK ((role <> 'DEV'::"Role"))` },
    ]);
  });

  it('locks the table with row-level security', async () => {
    const rows = await ctx.prisma.$queryRaw<Array<{ relrowsecurity: boolean }>>`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'RolePermissionOverride'
    `;
    expect(rows).toEqual([{ relrowsecurity: true }]);
  });

  it('adds the ROLE_PERMISSIONS_UPDATED audit action', async () => {
    const rows = await ctx.prisma.$queryRaw<Array<{ value: string }>>`
      SELECT unnest(enum_range(NULL::"AuditAction"))::text AS value
    `;
    expect(rows.map((row) => row.value)).toContain('ROLE_PERMISSIONS_UPDATED');
  });

  it('accepts a granted and a removed row, once per role and permission', async () => {
    await expect(insert('FRONT_DESK', `'ALL'`)).resolves.toBe(1);
    await expect(insert('COACH', 'NULL')).resolves.toBe(1);
    await expect(insert('FRONT_DESK', 'NULL')).rejects.toThrow();
  });

  it('refuses a row for the Super Admin', async () => {
    await expect(insert('DEV', `'ALL'`)).rejects.toThrow();
  });
});
