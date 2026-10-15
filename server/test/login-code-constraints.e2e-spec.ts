import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

const MEMBER_SUPABASE_ID = '65000000-0000-4000-8000-0000000000c1';
const SESSION = '65000000-0000-4000-8000-00000000005e';
const HASH = 'a'.repeat(64);

/**
 * The emailed sign-in code, asserted at the DATABASE (feat/login-code,
 * migrations 20261015000000_login_verification and
 * 20261015000100_login_code_realtime).
 *
 * Every rule here lives only in hand-written migration SQL: a `db push` or a
 * regenerated migration would drop it silently while every service test kept
 * passing.
 *
 * Written 2026-10-15 under the owner's batch-E2E rule and not yet run against
 * Postgres: the predicate strings are what `pg_get_constraintdef` is expected
 * to print, and are the first thing to check if this suite fails on its first run.
 */
describe('CHECK constraints — login code (e2e)', () => {
  let ctx: TestApp;
  let memberId: string;

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

  /** One sign-in row with every column valid; `over` is raw SQL per column. */
  const insertRow = (over: Record<string, string> = {}): Promise<number> => {
    const columns: Record<string, string> = {
      '"sessionId"': `'${SESSION}'`,
      '"userId"': `'${memberId}'`,
      '"codeHash"': `'${HASH}'`,
      '"codeExpiresAt"': `'2026-10-15T00:10:00Z'`,
      attempts: '0',
      '"sendCount"': '1',
      '"lastSentAt"': `'2026-10-15T00:00:00Z'`,
      '"createdAt"': `'2026-10-15T00:00:00Z'`,
      ...over,
    };
    return ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "LoginVerification" (${Object.keys(columns).join(', ')})
       VALUES (${Object.values(columns).join(', ')})`,
    );
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: MEMBER_SUPABASE_ID });
    memberId = await ctx.fixture.userIdFor(MEMBER_SUPABASE_ID);
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "LoginVerification"');
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "LoginCodeSetting"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('presence', () => {
    it('names exactly the LoginVerification CHECKs the migration wrote', async () => {
      expect(await checksOn('LoginVerification')).toEqual([
        'LoginVerification_attempts_range',
        'LoginVerification_code_hash_shape',
        'LoginVerification_code_pair',
        'LoginVerification_send_count_range',
        'LoginVerification_verified_after_created',
      ]);
      expect(await checksOn('LoginCodeSetting')).toEqual(['LoginCodeSetting_single_row']);
    });

    it('asserts each PREDICATE, not just the name', async () => {
      expect(await definitionOf('LoginVerification_code_hash_shape')).toBe(
        `CHECK ((("codeHash" IS NULL) OR ("codeHash" ~ '^[0-9a-f]{64}$'::text)))`,
      );
      expect(await definitionOf('LoginVerification_attempts_range')).toBe(
        'CHECK (((attempts >= 0) AND (attempts <= 5)))',
      );
      expect(await definitionOf('LoginVerification_send_count_range')).toBe(
        'CHECK ((("sendCount" >= 0) AND ("sendCount" <= 5)))',
      );
      expect(await definitionOf('LoginVerification_code_pair')).toBe(
        'CHECK ((("codeHash" IS NULL) = ("codeExpiresAt" IS NULL)))',
      );
      expect(await definitionOf('LoginVerification_verified_after_created')).toBe(
        'CHECK ((("verifiedAt" IS NULL) OR ("verifiedAt" >= "createdAt")))',
      );
      expect(await definitionOf('LoginCodeSetting_single_row')).toBe('CHECK ((id = 1))');
    });

    it('has RLS enabled on both tables', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
        SELECT relname, relrowsecurity FROM pg_class
         WHERE relname IN ('LoginVerification', 'LoginCodeSetting') ORDER BY relname
      `;
      expect(rows).toEqual([
        { relname: 'LoginCodeSetting', relrowsecurity: true },
        { relname: 'LoginVerification', relrowsecurity: true },
      ]);
    });

    it('cascades with its user and indexes userId', async () => {
      const fks = await ctx.prisma.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
        SELECT conname, confdeltype FROM pg_constraint
         WHERE conrelid = '"LoginVerification"'::regclass AND contype = 'f'
      `;
      expect(fks).toEqual([{ conname: 'LoginVerification_userId_fkey', confdeltype: 'c' }]);

      const indexes = await ctx.prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'LoginVerification' ORDER BY indexname
      `;
      expect(indexes.map((row) => row.indexname)).toEqual([
        'LoginVerification_pkey',
        'LoginVerification_userId_idx',
      ]);
    });
  });

  describe('LoginVerification rules', () => {
    it('accepts a valid row (positive control)', async () => {
      await expect(insertRow()).resolves.toBe(1);
    });

    it('accepts a verified row with the code cleared', async () => {
      await expect(
        insertRow({
          '"codeHash"': 'NULL',
          '"codeExpiresAt"': 'NULL',
          '"verifiedAt"': `'2026-10-15T00:01:00Z'`,
        }),
      ).resolves.toBe(1);
    });

    it('refuses a hash that is not 64 lower-case hex characters', async () => {
      await expect(insertRow({ '"codeHash"': `'${'A'.repeat(64)}'` })).rejects.toThrow(
        /LoginVerification_code_hash_shape/,
      );
    });

    it('refuses a hash without an expiry, and an expiry without a hash', async () => {
      await expect(insertRow({ '"codeExpiresAt"': 'NULL' })).rejects.toThrow(
        /LoginVerification_code_pair/,
      );
      await expect(insertRow({ '"codeHash"': 'NULL' })).rejects.toThrow(
        /LoginVerification_code_pair/,
      );
    });

    it('refuses attempts outside 0..5', async () => {
      await expect(insertRow({ attempts: '6' })).rejects.toThrow(
        /LoginVerification_attempts_range/,
      );
      await expect(insertRow({ attempts: '-1' })).rejects.toThrow(
        /LoginVerification_attempts_range/,
      );
    });

    it('refuses a send count outside 0..5', async () => {
      await expect(insertRow({ '"sendCount"': '6' })).rejects.toThrow(
        /LoginVerification_send_count_range/,
      );
    });

    it('refuses a verification before the row existed', async () => {
      await expect(insertRow({ '"verifiedAt"': `'2026-10-14T23:59:59Z'` })).rejects.toThrow(
        /LoginVerification_verified_after_created/,
      );
    });
  });

  describe('LoginCodeSetting', () => {
    it('holds one row, id 1', async () => {
      await ctx.prisma.$executeRawUnsafe(
        `INSERT INTO "LoginCodeSetting" (id, required, "updatedAt") VALUES (1, true, now())`,
      );
      await expect(
        ctx.prisma.$executeRawUnsafe(
          `INSERT INTO "LoginCodeSetting" (id, required, "updatedAt") VALUES (2, false, now())`,
        ),
      ).rejects.toThrow(/LoginCodeSetting_single_row/);
    });
  });

  /**
   * The Realtime half is GUARDED: plain Postgres (this harness) has no
   * `realtime` or `auth` schema, so it must be a no-op there. On a Supabase
   * scratch project the policy must call the verification function.
   */
  describe('Realtime policy', () => {
    it('applied the migration, and the policy calls login_session_verified() where Realtime exists', async () => {
      const [applied] = await ctx.prisma.$queryRaw<Array<{ done: boolean }>>`
        SELECT finished_at IS NOT NULL AND rolled_back_at IS NULL AS done
          FROM _prisma_migrations
         WHERE migration_name = '20261015000100_login_code_realtime'
      `;
      expect(applied?.done).toBe(true);

      const [probe] = await ctx.prisma.$queryRaw<Array<{ table: string | null }>>`
        SELECT to_regclass('realtime.messages')::text AS "table"
      `;

      const fn = await ctx.prisma.$queryRaw<Array<{ prosecdef: boolean }>>`
        SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'login_session_verified'
      `;

      if (probe.table === null) {
        expect(fn).toEqual([]);
        return;
      }

      expect(fn).toEqual([{ prosecdef: true }]);
      const [policy] = await ctx.prisma.$queryRaw<Array<{ qual: string }>>`
        SELECT qual FROM pg_policies
         WHERE schemaname = 'realtime' AND tablename = 'messages'
           AND policyname = 'user reads own private channel'
      `;
      expect(policy.qual).toContain(`realtime.topic()`);
      expect(policy.qual).toContain(`auth.uid()`);
      expect(policy.qual).toContain(`'broadcast'::text`);
      expect(policy.qual).toContain('login_session_verified()');
    });
  });
});
