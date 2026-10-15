import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

const MEMBER_SUPABASE_ID = '62000000-0000-4000-8000-0000000000a1';
const LEAVER_SUPABASE_ID = '62000000-0000-4000-8000-0000000000b1';
const SUBJECT_ID = '62000000-0000-4000-8000-00000000c001';

/**
 * Member notices, asserted at the DATABASE (class-booking fixes, migration
 * 20261011000000_member_notices).
 *
 * Every rule here lives only in hand-written migration SQL: a `db push` or a
 * regenerated migration would drop it silently while every service test kept
 * passing. So: the exact CHECK names and their PREDICATES as Postgres prints
 * them, the delete and update action of the foreign key, the unique dedupe key
 * and the feed's indexes, RLS enabled with no policies, the enum values in
 * order, and one raw insert per rule — each violating one constraint, so
 * Postgres names the one under test — plus positive controls.
 */
describe('CHECK constraints — member notices (e2e)', () => {
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

  /** One notice with every column valid; `over` is raw SQL per column. */
  const insertNotice = (over: Record<string, string> = {}, member = memberId): Promise<number> => {
    const columns: Record<string, string> = {
      id: 'gen_random_uuid()',
      '"userId"': `'${member}'`,
      kind: `'CLASS_PROMOTED'`,
      title: `'You''re in: Spin, Wed 14 Oct 6:00 pm'`,
      body: 'NULL',
      '"linkPath"': `'/portal/book?date=2026-10-14'`,
      '"subjectType"': 'NULL',
      '"subjectId"': 'NULL',
      '"dedupeKey"': 'NULL',
      ...over,
    };
    return ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "MemberNotice" (${Object.keys(columns).join(', ')})
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
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "MemberNotice"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('presence', () => {
    /** An EXACT set, not a subset: `toContain` would pass a stripped schema. */
    it('names exactly the CHECKs the migration wrote', async () => {
      expect(await checksOn('MemberNotice')).toEqual([
        'MemberNotice_body_sane',
        'MemberNotice_link_is_internal',
        'MemberNotice_subject_shape',
        'MemberNotice_title_sane',
      ]);
    });

    /**
     * Each PREDICATE exactly as `pg_get_constraintdef` prints it: BETWEEN is
     * stored as its two comparisons and LIKE as `~~`. The trims name their
     * character set — a bare `btrim(title)` here would mean a title of only
     * tabs and line breaks is back to passing as "not blank".
     */
    it('asserts each PREDICATE, not just the name', async () => {
      expect(await definitionOf('MemberNotice_title_sane')).toBe(
        "CHECK (((char_length(btrim(title, ' \t\r\n'::text)) >= 1) AND (char_length(btrim(title, ' \t\r\n'::text)) <= 120)))",
      );
      expect(await definitionOf('MemberNotice_body_sane')).toBe(
        "CHECK (((body IS NULL) OR ((char_length(btrim(body, ' \t\r\n'::text)) >= 1) AND (char_length(btrim(body, ' \t\r\n'::text)) <= 1000))))",
      );
      expect(await definitionOf('MemberNotice_link_is_internal')).toBe(
        `CHECK ((("linkPath" IS NULL) OR (("linkPath" ~~ '/%'::text) AND ("linkPath" !~~ '//%'::text) AND (strpos("linkPath", chr(92)) = 0))))`,
      );
      expect(await definitionOf('MemberNotice_subject_shape')).toBe(
        'CHECK ((("subjectType" IS NULL) = ("subjectId" IS NULL)))',
      );
    });

    /**
     * 'c' = CASCADE, on delete and on update: a member's notices are their
     * own personal data and go with them, like their class bookings.
     */
    it('cascades the one foreign key, to the member', async () => {
      const rows = await ctx.prisma.$queryRaw<
        Array<{ conname: string; confdeltype: string; confupdtype: string }>
      >`
        SELECT conname, confdeltype::text AS confdeltype, confupdtype::text AS confupdtype
          FROM pg_constraint
         WHERE contype = 'f' AND conrelid = '"MemberNotice"'::regclass
         ORDER BY conname
      `;
      expect(rows).toEqual([
        { conname: 'MemberNotice_userId_fkey', confdeltype: 'c', confupdtype: 'c' },
      ]);
    });

    /**
     * Exactly these four, under the names Prisma generates for the model —
     * so the next `migrate diff` sees nothing to rename or recreate.
     */
    it('has the primary key, the unique dedupe key and the two feed indexes', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'MemberNotice'
      `;
      expect(rows.map((row) => row.indexname).sort()).toEqual([
        'MemberNotice_dedupeKey_key',
        'MemberNotice_pkey',
        'MemberNotice_userId_createdAt_id_idx',
        'MemberNotice_userId_readAt_idx',
      ]);

      const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));
      expect(byName.get('MemberNotice_pkey')).toMatch(/CREATE UNIQUE INDEX .* USING btree \(id\)$/);
      expect(byName.get('MemberNotice_dedupeKey_key')).toMatch(
        /CREATE UNIQUE INDEX .* USING btree \("dedupeKey"\)$/,
      );
      expect(byName.get('MemberNotice_userId_createdAt_id_idx')).toMatch(
        /^CREATE INDEX .* USING btree \("userId", "createdAt" DESC, id DESC\)$/,
      );
      expect(byName.get('MemberNotice_userId_readAt_idx')).toMatch(
        /^CREATE INDEX .* USING btree \("userId", "readAt"\)$/,
      );
    });

    /** ENABLE, not FORCE: the server's BYPASSRLS role reads on; anon and authenticated get nothing. */
    it('locks the table with row-level security and no policies', async () => {
      const rows = await ctx.prisma.$queryRaw<
        Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
      >`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'MemberNotice'
      `;
      expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: false }]);

      const [policies] = await ctx.prisma.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pg_policies WHERE tablename = 'MemberNotice'
      `;
      expect(policies.count).toBe(0);
    });

    it('creates MemberNoticeKind with exactly the five kinds, in order', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ value: string }>>`
        SELECT unnest(enum_range(NULL::"MemberNoticeKind"))::text AS value
      `;
      expect(rows.map((row) => row.value)).toEqual([
        'CLASS_PROMOTED',
        'CLASS_CANCELLED',
        'CLASS_CHANGED',
        'BOOKING_ADDED',
        'BOOKING_REMOVED',
      ]);
    });
  });

  describe('rows', () => {
    it('accepts a full notice and a bare one (positive controls)', async () => {
      await expect(
        insertNotice({
          body: `'A place opened up and it''s yours.'`,
          '"subjectType"': `'ClassBooking'`,
          '"subjectId"': `'${SUBJECT_ID}'`,
          '"dedupeKey"': `'CLASS_PROMOTED:${SUBJECT_ID}:1760000000000'`,
          '"readAt"': 'now()',
        }),
      ).resolves.toBe(1);
      await expect(insertNotice({ '"linkPath"': 'NULL' })).resolves.toBe(1);
    });

    it('takes 1-120 characters of title, counted after the trim — MemberNotice_title_sane', async () => {
      // Padding of spaces, tabs and line breaks is not counted.
      for (const title of [`'x'`, `'${'x'.repeat(120)}'`, `E'\\t ${'x'.repeat(120)} \\r\\n'`]) {
        await expect(insertNotice({ title })).resolves.toBe(1);
      }
      // Blank, blank in any whitespace a bare btrim() would have kept, too long.
      for (const title of [`''`, `'   '`, `E' \\t\\r\\n '`, `'${'x'.repeat(121)}'`]) {
        await expect(insertNotice({ title })).rejects.toThrow(/MemberNotice_title_sane/);
      }
    });

    it('takes no body, or 1-1000 characters of one — MemberNotice_body_sane', async () => {
      for (const body of ['NULL', `'Coach is unwell.'`, `'${'b'.repeat(1000)}'`]) {
        await expect(insertNotice({ body })).resolves.toBe(1);
      }
      for (const body of [`''`, `'  '`, `E'\\n\\t\\r'`, `'${'b'.repeat(1001)}'`]) {
        await expect(insertNotice({ body })).rejects.toThrow(/MemberNotice_body_sane/);
      }
    });

    it('keeps the link inside the app — MemberNotice_link_is_internal', async () => {
      for (const link of [`'/portal/book?date=2026-10-14'`, `'/portal'`]) {
        await expect(insertNotice({ '"linkPath"': link })).resolves.toBe(1);
      }
      for (const link of [
        `'https://evil.example/portal'`,
        `'//evil.example'`,
        // `/\evil.example`: browsers read the backslash as a second slash.
        `'/' || chr(92) || 'evil.example'`,
        `'portal/book'`,
        `''`,
      ]) {
        await expect(insertNotice({ '"linkPath"': link })).rejects.toThrow(
          /MemberNotice_link_is_internal/,
        );
      }
    });

    it('names a subject as a type and an id together, or not at all — MemberNotice_subject_shape', async () => {
      await expect(
        insertNotice({ '"subjectType"': `'ClassSession'`, '"subjectId"': `'${SUBJECT_ID}'` }),
      ).resolves.toBe(1);
      await expect(insertNotice({ '"subjectType"': `'ClassSession'` })).rejects.toThrow(
        /MemberNotice_subject_shape/,
      );
      await expect(insertNotice({ '"subjectId"': `'${SUBJECT_ID}'` })).rejects.toThrow(
        /MemberNotice_subject_shape/,
      );
    });

    it('allows one notice per dedupe key, and any number without one', async () => {
      const key = `'CLASS_CANCELLED:${SUBJECT_ID}:${SUBJECT_ID}'`;
      await expect(insertNotice({ '"dedupeKey"': key })).resolves.toBe(1);
      await expect(insertNotice({ '"dedupeKey"': key })).rejects.toThrow(/23505[\s\S]*dedupeKey/);
      // NULLs never collide.
      await expect(insertNotice()).resolves.toBe(1);
      await expect(insertNotice()).resolves.toBe(1);
    });

    it('goes with the member (CASCADE): deleting the account deletes only their notices', async () => {
      await ctx.fixture.tokenFor('CLIENT', { supabaseId: LEAVER_SUPABASE_ID });
      const leaverId = await ctx.fixture.userIdFor(LEAVER_SUPABASE_ID);
      await insertNotice({}, leaverId);
      await insertNotice({}, leaverId);
      await insertNotice();

      await expect(
        ctx.prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = '${leaverId}'`),
      ).resolves.toBe(1);

      const rows = await ctx.prisma.$queryRawUnsafe<Array<{ userId: string }>>(
        `SELECT "userId" FROM "MemberNotice"`,
      );
      expect(rows).toEqual([{ userId: memberId }]);
    });
  });
});
