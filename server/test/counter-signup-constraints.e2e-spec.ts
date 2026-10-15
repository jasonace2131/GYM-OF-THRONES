import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

const MEMBER_SUPABASE_ID = '64000000-0000-4000-8000-0000000000c1';
const ADMIN_SUPABASE_ID = '64000000-0000-4000-8000-0000000000a1';
const HASH = 'a'.repeat(64);

/**
 * Counter sign-up, asserted at the DATABASE (feat/counter-signup, migrations
 * 20261014010000_audit_action_member_email and 20261014010100_counter_signup).
 *
 * Every rule here lives only in hand-written migration SQL: a `db push` or a
 * regenerated migration would drop it silently while every service test kept
 * passing.
 *
 * Written 2026-10-14 under the owner's batch-E2E rule and not yet run against
 * Postgres: the predicate strings are what `pg_get_constraintdef` is expected
 * to print, and are the first thing to check if this suite fails on its first run.
 */
describe('CHECK constraints — counter sign-up (e2e)', () => {
  let ctx: TestApp;
  let memberId: string;
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

  /** One link with every column valid; `over` is raw SQL per column. */
  const insertLink = (over: Record<string, string> = {}): Promise<number> => {
    const columns: Record<string, string> = {
      id: 'gen_random_uuid()',
      '"userId"': `'${memberId}'`,
      '"tokenHash"': `'${HASH}'`,
      '"issuedAt"': `'2026-10-14T00:00:00Z'`,
      '"expiresAt"': `'2026-10-21T00:00:00Z'`,
      '"issuedById"': `'${adminId}'`,
      ...over,
    };
    return ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "MemberJoinLink" (${Object.keys(columns).join(', ')})
       VALUES (${Object.values(columns).join(', ')})`,
    );
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: MEMBER_SUPABASE_ID });
    await ctx.fixture.tokenFor('ADMIN', { supabaseId: ADMIN_SUPABASE_ID });
    memberId = await ctx.fixture.userIdFor(MEMBER_SUPABASE_ID);
    adminId = await ctx.fixture.userIdFor(ADMIN_SUPABASE_ID);
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "MemberJoinLink"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('presence', () => {
    it('names exactly the MemberJoinLink CHECKs the migration wrote', async () => {
      expect(await checksOn('MemberJoinLink')).toEqual([
        'MemberJoinLink_expiry_after_issue',
        'MemberJoinLink_token_hash_shape',
        'MemberJoinLink_used_after_issue',
      ]);
    });

    it('asserts each PREDICATE, not just the name', async () => {
      expect(await definitionOf('MemberJoinLink_token_hash_shape')).toBe(
        `CHECK (("tokenHash" ~ '^[0-9a-f]{64}$'::text))`,
      );
      expect(await definitionOf('MemberJoinLink_expiry_after_issue')).toBe(
        'CHECK (("expiresAt" > "issuedAt"))',
      );
      expect(await definitionOf('MemberJoinLink_used_after_issue')).toBe(
        'CHECK ((("usedAt" IS NULL) OR ("usedAt" >= "issuedAt")))',
      );
      expect(await definitionOf('CheckIn_guest_email_sane')).toBe(
        `CHECK ((("guestEmail" IS NULL) OR (("guestEmail" = lower(btrim("guestEmail"))) AND ((char_length("guestEmail") >= 3) AND (char_length("guestEmail") <= 254)))))`,
      );
    });

    it('has RLS enabled on MemberJoinLink', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ relrowsecurity: boolean }>>`
        SELECT relrowsecurity FROM pg_class WHERE relname = 'MemberJoinLink'
      `;
      expect(rows[0].relrowsecurity).toBe(true);
    });

    it('adds the MEMBER_EMAIL_CHANGED audit value', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ value: string }>>`
        SELECT unnest(enum_range(NULL::"AuditAction"))::text AS value
      `;
      expect(rows.map((row) => row.value)).toContain('MEMBER_EMAIL_CHANGED');
    });
  });

  describe('MemberJoinLink rules', () => {
    it('accepts a valid row (positive control)', async () => {
      await expect(insertLink()).resolves.toBe(1);
    });

    it('refuses a token hash that is not 64 lower-case hex characters', async () => {
      await expect(insertLink({ '"tokenHash"': `'${'A'.repeat(64)}'` })).rejects.toThrow(
        /MemberJoinLink_token_hash_shape/,
      );
    });

    it('refuses an expiry at or before the issue time', async () => {
      await expect(insertLink({ '"expiresAt"': `'2026-10-14T00:00:00Z'` })).rejects.toThrow(
        /MemberJoinLink_expiry_after_issue/,
      );
    });

    it('refuses a use before the issue time', async () => {
      await expect(insertLink({ '"usedAt"': `'2026-10-13T00:00:00Z'` })).rejects.toThrow(
        /MemberJoinLink_used_after_issue/,
      );
    });

    it('allows one link per member', async () => {
      await insertLink();
      await expect(insertLink({ '"tokenHash"': `'${'b'.repeat(64)}'` })).rejects.toThrow(
        /MemberJoinLink_userId_key/,
      );
    });

    it('deletes the link with its member (CASCADE) and keeps it when the issuer goes (SET NULL)', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
        SELECT conname, confdeltype FROM pg_constraint
        WHERE conrelid = '"MemberJoinLink"'::regclass AND contype = 'f' ORDER BY conname
      `;
      expect(rows).toEqual([
        { conname: 'MemberJoinLink_issuedById_fkey', confdeltype: 'n' },
        { conname: 'MemberJoinLink_userId_fkey', confdeltype: 'c' },
      ]);
    });
  });

  describe('CheckIn.guestEmail', () => {
    it('still lets an old account-less walk-in with NO email be updated — no CHECK requires it', async () => {
      const [row] = await ctx.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "CheckIn" WHERE "userId" IS NULL AND "guestEmail" IS NULL LIMIT 1
      `;
      // The reset database may hold no guest visit; the assertion that matters is
      // that no CHECK on CheckIn names guestEmail as required.
      const checks = await checksOn('CheckIn');
      expect(checks.filter((name) => name.includes('guest_email'))).toEqual([
        'CheckIn_guest_email_sane',
      ]);
      if (row !== undefined) {
        await expect(
          ctx.prisma.$executeRawUnsafe(
            `UPDATE "CheckIn" SET "guestName" = "guestName" WHERE id = '${row.id}'`,
          ),
        ).resolves.toBe(1);
      }
    });
  });
});
