import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';

/**
 * The rich-announcement columns, asserted at the DATABASE.
 *
 * Every rule here lives only in hand-written migration SQL
 * (20260826000000_announcements, 20260928000100_announcement_rich_content): a
 * `db push` or a regenerated migration would drop it silently while every
 * service test kept passing. So: the exact CHECK name list, each predicate,
 * and one raw insert per rule — each violating at most one constraint, so
 * Postgres names the one under test — plus positive controls.
 */
describe('CHECK constraints — announcements (e2e)', () => {
  let ctx: TestApp;
  let authorId: string;

  const quote = (value: string | null): string =>
    value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`;

  const insert = (values: {
    title?: string;
    content?: string;
    contentJson?: string | null;
    coverImageUrl?: string | null;
  }): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "Announcement" (id, title, content, "contentJson", "coverImageUrl", "authorId", "updatedAt")
       VALUES (gen_random_uuid(), ${quote(values.title ?? 'Holiday hours')},
               ${quote(values.content ?? 'We close at 6pm.')},
               ${values.contentJson === undefined || values.contentJson === null ? 'NULL' : `${quote(values.contentJson)}::jsonb`},
               ${quote(values.coverImageUrl ?? null)}, '${authorId}', now())`,
    );

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
    authorId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "Announcement"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('presence', () => {
    const definitionOf = async (name: string): Promise<string> => {
      const rows = await ctx.prisma.$queryRaw<Array<{ def: string }>>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}
      `;
      expect(rows).toHaveLength(1);
      return rows[0].def;
    };

    /** An EXACT set, not a subset: `toContain` would pass a stripped schema. */
    it('carries every Announcement CHECK', async () => {
      const rows = await ctx.prisma.$queryRawUnsafe<Array<{ conname: string }>>(
        `SELECT conname FROM pg_constraint WHERE conrelid = '"Announcement"'::regclass AND contype = 'c' ORDER BY conname`,
      );
      expect(rows.map((row) => row.conname)).toEqual([
        'Announcement_contentJson_is_doc',
        'Announcement_content_sane',
        'Announcement_coverImageUrl_https',
        'Announcement_title_sane',
      ]);
    });

    /** The predicates, not just the names — a renamed-but-wrong CHECK passes a name test. */
    it('defines the contentJson and cover predicates', async () => {
      const doc = await definitionOf('Announcement_contentJson_is_doc');
      expect(doc).toContain('"contentJson" IS NULL');
      expect(doc).toContain('jsonb_typeof("contentJson") = \'object\'');
      expect(doc).toContain("(\"contentJson\" ->> 'type'::text) = 'doc'");

      const cover = await definitionOf('Announcement_coverImageUrl_https');
      expect(cover).toContain('"coverImageUrl" IS NULL');
      expect(cover).toContain("'https://'");
      expect(cover).toContain('char_length("coverImageUrl") <= 2048');
    });

    it('keeps the original content bound — 1 to 4000 trimmed characters', async () => {
      const content = await definitionOf('Announcement_content_sane');
      expect(content).toContain('char_length(btrim(content)) >= 1');
      expect(content).toContain('char_length(btrim(content)) <= 4000');
    });

    it('stores contentJson as jsonb and both new columns as nullable', async () => {
      const rows = await ctx.prisma.$queryRaw<
        Array<{ column_name: string; data_type: string; is_nullable: string }>
      >`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'Announcement' AND column_name IN ('contentJson', 'coverImageUrl')
        ORDER BY column_name
      `;
      expect(rows).toEqual([
        { column_name: 'contentJson', data_type: 'jsonb', is_nullable: 'YES' },
        { column_name: 'coverImageUrl', data_type: 'text', is_nullable: 'YES' },
      ]);
    });

    it('adds the three announcement audit actions to the enum', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ value: string }>>`
        SELECT unnest(enum_range(NULL::"AuditAction"))::text AS value
      `;
      expect(rows.map((row) => row.value)).toEqual(
        expect.arrayContaining([
          'ANNOUNCEMENT_CREATED',
          'ANNOUNCEMENT_UPDATED',
          'ANNOUNCEMENT_DELETED',
        ]),
      );
    });
  });

  describe('rows', () => {
    it('accepts a plain notice with no JSON and no cover (positive control)', async () => {
      await expect(insert({})).resolves.toBe(1);
    });

    it('accepts a doc and an https cover (positive control)', async () => {
      await expect(
        insert({
          contentJson: '{"type":"doc","content":[]}',
          coverImageUrl: 'https://x.supabase.co/storage/v1/object/public/announcements/a.webp',
        }),
      ).resolves.toBe(1);
    });

    it.each([
      ['a paragraph root', '{"type":"paragraph"}'],
      ['an array', '[{"type":"doc"}]'],
      ['a string', '"doc"'],
      ['a doc-less object', '{"content":[]}'],
    ])('rejects contentJson as %s — Announcement_contentJson_is_doc', async (_label, json) => {
      await expect(insert({ contentJson: json })).rejects.toThrow(
        /Announcement_contentJson_is_doc/,
      );
    });

    it.each([
      ['plain http', 'http://x.supabase.co/a.webp'],
      ['a data: URL', 'data:image/svg+xml,<svg/>'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['an over-long URL', `https://x/${'a'.repeat(2048)}`],
    ])('rejects a cover of %s — Announcement_coverImageUrl_https', async (_label, url) => {
      await expect(insert({ coverImageUrl: url })).rejects.toThrow(
        /Announcement_coverImageUrl_https/,
      );
    });

    it('still rejects blank content — Announcement_content_sane', async () => {
      await expect(insert({ content: '   ' })).rejects.toThrow(/Announcement_content_sane/);
    });
  });
});
