import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

const ADMIN_SUPABASE_ID = '50000000-0000-4000-8000-0000000000ad';
const COACH_SUPABASE_ID = '50000000-0000-4000-8000-0000000000c1';

jest.setTimeout(180_000);

/**
 * Staff & Access, asserted at the DATABASE.
 *
 * Every rule here lives only in hand-written migration SQL
 * (20260927000100_staff_invitations_coach_profiles): a `db push` or a
 * regenerated migration drops it silently while every service test keeps
 * passing. So: the exact CHECK name lists, each predicate, the partial unique
 * index's PREDICATE (not just its name), the delete action of every foreign
 * key, RLS, and one raw insert per rule — each violating exactly one
 * constraint, so Postgres names the one under test — plus positive controls.
 */
describe('Staff & Access constraints (e2e)', () => {
  let ctx: TestApp;
  let adminId: string;
  let coachId: string;

  const HASH = (c: string): string => c.repeat(64);

  /** A raw invitation insert; every column defaults to a valid value. */
  const insertInvitation = (values: Record<string, string> = {}): Promise<number> => {
    const row: Record<string, string> = {
      id: 'gen_random_uuid()',
      email: `'ana@example.com'`,
      role: `'COACH'`,
      '"tokenHash"': `'${HASH('a')}'`,
      '"invitedById"': `'${adminId}'`,
      '"createdAt"': `'2026-09-25T00:00:00Z'`,
      '"expiresAt"': `'2026-10-02T00:00:00Z'`,
      '"acceptedAt"': 'NULL',
      '"acceptedById"': 'NULL',
      '"revokedAt"': 'NULL',
      '"revokedById"': 'NULL',
      ...values,
    };
    return ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "StaffInvitation" (${Object.keys(row).join(', ')})
       VALUES (${Object.values(row).join(', ')})`,
    );
  };

  const insertProfile = (specializations: string, bio: string): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "CoachProfile" ("userId", specializations, bio, "updatedAt", "updatedById")
       VALUES ('${coachId}', ${specializations}, ${bio}, now(), '${adminId}')`,
    );

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await ctx.fixture.tokenFor('ADMIN', { supabaseId: ADMIN_SUPABASE_ID });
    await ctx.fixture.tokenFor('COACH', { supabaseId: COACH_SUPABASE_ID });
    adminId = await ctx.fixture.userIdFor(ADMIN_SUPABASE_ID);
    coachId = await ctx.fixture.userIdFor(COACH_SUPABASE_ID);
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "StaffInvitation"');
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "CoachProfile"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  const checksOn = async (table: string): Promise<string[]> => {
    const rows = await ctx.prisma.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"${table}"'::regclass AND contype = 'c'`,
    );
    return rows.map((row) => row.conname).sort();
  };

  const definitionOf = async (name: string): Promise<string> => {
    const rows = await ctx.prisma.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}
    `;
    expect(rows).toHaveLength(1);
    return rows[0].def;
  };

  describe('presence', () => {
    /** An EXACT set, not a subset: `toContain` would pass a stripped schema. */
    it('carries every StaffInvitation CHECK', async () => {
      expect(await checksOn('StaffInvitation')).toEqual([
        'StaffInvitation_accepted_shape',
        'StaffInvitation_email_normalised',
        'StaffInvitation_expiry_after_issue',
        'StaffInvitation_revoked_shape',
        'StaffInvitation_role_staff',
        'StaffInvitation_single_outcome',
        'StaffInvitation_token_hash_shape',
      ]);
    });

    it('carries every CoachProfile CHECK', async () => {
      expect(await checksOn('CoachProfile')).toEqual([
        'CoachProfile_bio_shape',
        'CoachProfile_specializations_shape',
      ]);
    });

    it('defines each predicate, not just the name', async () => {
      expect(await definitionOf('StaffInvitation_role_staff')).toMatch(/FRONT_DESK.*COACH.*ADMIN/);
      expect(await definitionOf('StaffInvitation_role_staff')).not.toMatch(/CLIENT|DEV/);
      expect(await definitionOf('StaffInvitation_email_normalised')).toContain(
        'lower(btrim(email))',
      );
      expect(await definitionOf('StaffInvitation_token_hash_shape')).toContain('^[0-9a-f]{64}$');
      expect(await definitionOf('StaffInvitation_accepted_shape')).toContain(
        '("acceptedAt" IS NULL) = ("acceptedById" IS NULL)',
      );
      expect(await definitionOf('StaffInvitation_revoked_shape')).toContain(
        '("revokedAt" IS NULL) = ("revokedById" IS NULL)',
      );
      expect(await definitionOf('StaffInvitation_single_outcome')).toContain(
        '("acceptedAt" IS NULL) OR ("revokedAt" IS NULL)',
      );
      expect(await definitionOf('StaffInvitation_expiry_after_issue')).toContain(
        '"expiresAt" > "createdAt"',
      );
      expect(await definitionOf('CoachProfile_specializations_shape')).toContain(
        'coach_specializations_valid(specializations)',
      );
      expect(await definitionOf('CoachProfile_bio_shape')).toContain('char_length(bio) <= 500');
    });

    /**
     * The PREDICATE, not the name. An index named right with the wrong WHERE
     * (or none) is the StationScan_opening_checkin_once lesson: it would pass
     * a name check and either block every re-invite or allow two live ones.
     */
    it('makes "one open invitation per address" a PARTIAL unique index on email', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'StaffInvitation_one_open_per_email'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toContain('CREATE UNIQUE INDEX');
      expect(rows[0].indexdef).toContain('(email)');
      expect(rows[0].indexdef).toContain(
        'WHERE (("acceptedAt" IS NULL) AND ("revokedAt" IS NULL))',
      );
    });

    /** 'r' = RESTRICT (named actors), 'c' = CASCADE (the coach's own profile). */
    it('restricts every actor FK and cascades the profile owner', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
        SELECT conname, confdeltype FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid IN ('"StaffInvitation"'::regclass, '"CoachProfile"'::regclass)
        ORDER BY conname
      `;
      expect(rows).toEqual([
        { conname: 'CoachProfile_updatedById_fkey', confdeltype: 'r' },
        { conname: 'CoachProfile_userId_fkey', confdeltype: 'c' },
        { conname: 'StaffInvitation_acceptedById_fkey', confdeltype: 'r' },
        { conname: 'StaffInvitation_invitedById_fkey', confdeltype: 'r' },
        { conname: 'StaffInvitation_revokedById_fkey', confdeltype: 'r' },
      ]);
    });

    it('enables row level security on both tables', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
        SELECT relname, relrowsecurity FROM pg_class
        WHERE relname IN ('StaffInvitation', 'CoachProfile') ORDER BY relname
      `;
      expect(rows).toEqual([
        { relname: 'CoachProfile', relrowsecurity: true },
        { relname: 'StaffInvitation', relrowsecurity: true },
      ]);
    });
  });

  describe('StaffInvitation rows', () => {
    it('accepts a well-formed open invitation (positive control)', async () => {
      await expect(insertInvitation()).resolves.toBe(1);
    });

    it.each([
      ['a CLIENT role', { role: `'CLIENT'` }, 'StaffInvitation_role_staff'],
      ['a DEV role', { role: `'DEV'` }, 'StaffInvitation_role_staff'],
      ['a mixed-case address', { email: `'Ana@Example.com'` }, 'StaffInvitation_email_normalised'],
      ['a padded address', { email: `' ana@example.com'` }, 'StaffInvitation_email_normalised'],
      [
        'a raw token instead of a hash',
        { '"tokenHash"': `'${'Z'.repeat(64)}'` },
        'StaffInvitation_token_hash_shape',
      ],
      [
        'acceptedAt without acceptedById',
        { '"acceptedAt"': 'now()' },
        'StaffInvitation_accepted_shape',
      ],
      [
        'revokedById without revokedAt',
        { '"revokedById"': 'INVITED' },
        'StaffInvitation_revoked_shape',
      ],
      [
        'an expiry before issue',
        { '"expiresAt"': `'2026-09-24T00:00:00Z'` },
        'StaffInvitation_expiry_after_issue',
      ],
    ])('refuses %s', async (_label, values, constraint) => {
      const resolved = Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, v === 'INVITED' ? `'${adminId}'` : v]),
      );
      await expect(insertInvitation(resolved)).rejects.toThrow(constraint);
    });

    it('refuses an invitation both accepted and revoked', async () => {
      await expect(
        insertInvitation({
          '"acceptedAt"': 'now()',
          '"acceptedById"': `'${coachId}'`,
          '"revokedAt"': 'now()',
          '"revokedById"': `'${adminId}'`,
        }),
      ).rejects.toThrow('StaffInvitation_single_outcome');
    });

    it('refuses a SECOND open invitation for one address', async () => {
      await insertInvitation();
      await expect(insertInvitation({ '"tokenHash"': `'${HASH('b')}'` })).rejects.toThrow(
        'StaffInvitation_one_open_per_email',
      );
    });

    it('allows a new invitation once the old one is closed (the predicate, exercised)', async () => {
      await insertInvitation({ '"revokedAt"': 'now()', '"revokedById"': `'${adminId}'` });
      await insertInvitation({
        '"tokenHash"': `'${HASH('b')}'`,
        '"acceptedAt"': 'now()',
        '"acceptedById"': `'${coachId}'`,
      });
      await expect(insertInvitation({ '"tokenHash"': `'${HASH('c')}'` })).resolves.toBe(1);
    });
  });

  describe('CoachProfile rows', () => {
    it('accepts five tags and a bio (positive control)', async () => {
      await expect(
        insertProfile(
          `ARRAY['Strength','Mobility','Boxing','Yoga','HIIT']`,
          `'Ten years coaching.'`,
        ),
      ).resolves.toBe(1);
    });

    it('accepts no tags and no bio', async () => {
      await expect(insertProfile(`ARRAY[]::text[]`, 'NULL')).resolves.toBe(1);
    });

    it.each([
      ['six tags', `ARRAY['a','b','c','d','e','f']`],
      ['an empty tag', `ARRAY['']`],
      ['a padded tag', `ARRAY[' Strength']`],
      ['a 41-character tag', `ARRAY['${'x'.repeat(41)}']`],
      ['a NULL tag', `ARRAY[NULL]::text[]`],
      ['a NULL array', `NULL`],
    ])('refuses %s', async (_label, tags) => {
      await expect(insertProfile(tags, 'NULL')).rejects.toThrow(
        'CoachProfile_specializations_shape',
      );
    });

    it.each([
      ['a blank bio', `'   '`],
      ['a 501-character bio', `'${'x'.repeat(501)}'`],
    ])('refuses %s', async (_label, bio) => {
      await expect(insertProfile(`ARRAY[]::text[]`, bio)).rejects.toThrow('CoachProfile_bio_shape');
    });
  });
});
