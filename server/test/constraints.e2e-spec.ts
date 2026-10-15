import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

const COACH_SUPABASE_ID = '30000000-0000-4000-8000-00000000000c';
const MEMBER_SUPABASE_ID = '30000000-0000-4000-8000-00000000000d';
const OTHER_SUPABASE_ID = '30000000-0000-4000-8000-00000000000e';

/**
 * Asserts the CONSTRAINT, not the service.
 *
 * A test that only checks the service sets the right columns passes happily
 * against a database that lost every CHECK in an unrelated migration. Each row
 * below violates exactly one constraint, so Postgres names the one under test.
 *
 * Two subjects share this file's app/database setup: CoachAssignment's four
 * CHECKs, and the User suspension trio C1 added. They are separated by the
 * inner `describe`s below rather than by a second suite, which would pay the
 * whole `createTestApp` + `resetDatabase` cost again to assert three names.
 */
describe('CHECK constraints — CoachAssignment and User (e2e)', () => {
  let ctx: TestApp;
  let coachId: string;
  let memberId: string;
  let otherId: string;

  const insert = (columns: string, values: string): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(`INSERT INTO "CoachAssignment" (${columns}) VALUES (${values})`);

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);

    await ctx.fixture.tokenFor('COACH', { supabaseId: COACH_SUPABASE_ID });
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: MEMBER_SUPABASE_ID });
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: OTHER_SUPABASE_ID });

    coachId = await ctx.fixture.userIdFor(COACH_SUPABASE_ID);
    memberId = await ctx.fixture.userIdFor(MEMBER_SUPABASE_ID);
    otherId = await ctx.fixture.userIdFor(OTHER_SUPABASE_ID);
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "CoachAssignment"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('CoachAssignment', () => {
    it('has all four CHECK constraints on the table', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = '"CoachAssignment"'::regclass AND contype = 'c'
      `;
      const names = rows.map((row) => row.conname).sort();

      expect(names).toEqual([
        'CoachAssignment_active_marker',
        'CoachAssignment_active_marker_agrees',
        'CoachAssignment_end_shape',
        'CoachAssignment_not_self',
      ]);
    });

    it('accepts a well-formed ACTIVE row (positive control)', async () => {
      await expect(
        insert(
          'id, "coachId", "memberId", "status", "activeMemberId", "assignedById", "updatedAt"',
          `gen_random_uuid(), '${coachId}', '${memberId}', 'ACTIVE', '${memberId}', '${coachId}', now()`,
        ),
      ).resolves.toBe(1);
    });

    it('rejects a coach assigned to themselves — CoachAssignment_not_self', async () => {
      await expect(
        insert(
          'id, "coachId", "memberId", "status", "activeMemberId", "assignedById", "updatedAt"',
          `gen_random_uuid(), '${coachId}', '${coachId}', 'ACTIVE', '${coachId}', '${coachId}', now()`,
        ),
      ).rejects.toThrow(/CoachAssignment_not_self/);
    });

    it('rejects a sentinel that names a different member — CoachAssignment_active_marker', async () => {
      await expect(
        insert(
          'id, "coachId", "memberId", "status", "activeMemberId", "assignedById", "updatedAt"',
          `gen_random_uuid(), '${coachId}', '${memberId}', 'ACTIVE', '${otherId}', '${coachId}', now()`,
        ),
      ).rejects.toThrow(/CoachAssignment_active_marker\b/);
    });

    it('rejects ACTIVE with no sentinel — CoachAssignment_active_marker_agrees', async () => {
      await expect(
        insert(
          'id, "coachId", "memberId", "status", "activeMemberId", "assignedById", "updatedAt"',
          `gen_random_uuid(), '${coachId}', '${memberId}', 'ACTIVE', NULL, '${coachId}', now()`,
        ),
      ).rejects.toThrow(/CoachAssignment_active_marker_agrees/);
    });

    it('rejects ACTIVE carrying an endedAt — CoachAssignment_end_shape', async () => {
      await expect(
        insert(
          'id, "coachId", "memberId", "status", "activeMemberId", "endedAt", "assignedById", "updatedAt"',
          `gen_random_uuid(), '${coachId}', '${memberId}', 'ACTIVE', '${memberId}', now(), '${coachId}', now()`,
        ),
      ).rejects.toThrow(/CoachAssignment_end_shape/);
    });

    it('enforces one active coach per member through the nullable-unique sentinel', async () => {
      await insert(
        'id, "coachId", "memberId", "status", "activeMemberId", "assignedById", "updatedAt"',
        `gen_random_uuid(), '${coachId}', '${memberId}', 'ACTIVE', '${memberId}', '${coachId}', now()`,
      );

      // Prisma's $executeRawUnsafe error path formats a unique violation (23505)
      // from Postgres's DETAIL field only, dropping the main "duplicate key
      // value violates unique constraint ..." line the CHECK violations above
      // get — so the constraint NAME never reaches `.message` or `.meta` here
      // (unlike an ORM-level `prisma.model.create`, which does get P2002 +
      // `meta.target`; that is what mapPrismaError's test doubles exercise).
      // The DETAIL text still names the sentinel COLUMN, which is unique to
      // `CoachAssignment_activeMemberId_key` on this table, so it is still
      // proof this is the constraint that fired.
      // The DETAIL-text assertion is `lc_messages`-locale dependent — a server
      // running with a non-English locale renders a differently-worded message.
      // `error.meta.code` is Postgres's own SQLSTATE (23505 = unique_violation)
      // and is locale-invariant, so it backstops the text assertion rather than
      // replacing it.
      let caught: unknown;
      try {
        await insert(
          'id, "coachId", "memberId", "status", "activeMemberId", "assignedById", "updatedAt"',
          `gen_random_uuid(), '${otherId}', '${memberId}', 'ACTIVE', '${memberId}', '${coachId}', now()`,
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        message: expect.stringMatching(/"activeMemberId"\).*already exists/) as unknown,
        meta: expect.objectContaining({ code: '23505' }) as unknown,
      });
    });
  });

  describe('User suspension', () => {
    /**
     * C1's suspension trio (20260827000000_member_suspend_fields), asserted the
     * same way and for the same reason as the CoachAssignment block above: a
     * service test that only checks `suspend()` writes four columns passes
     * happily against a database where the CHECKs went missing.
     *
     * The migration adds them NOT VALID and VALIDATEs them in a second
     * statement, so `convalidated` is asserted too — a constraint left NOT
     * VALID still guards new writes but silently tolerates whatever bad row
     * made the validation fail, which is precisely the state nobody would
     * notice without this.
     */
    it('carries the three User suspension CHECKs, all validated', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ conname: string; convalidated: boolean }>>`
        SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = '"User"'::regclass AND contype = 'c' AND conname LIKE 'User\\_suspend\\_%'
      `;

      expect(rows.map((row) => row.conname).sort()).toEqual([
        'User_suspend_actor_shape',
        'User_suspend_reason_shape',
        'User_suspend_shape',
      ]);
      expect(rows.every((row) => row.convalidated)).toBe(true);
    });
  });

  /**
   * The amendment link and the archive pair — 20260922000100.
   *
   * Hand-written SQL, so there is no Prisma representation of the CHECKs or
   * the partial index and a `migrate diff`, a `--create-only` regeneration or
   * a local `db push` drops them silently while every service test keeps
   * passing. This block is the only thing that notices.
   */
  describe('Payment amendment and archive', () => {
    it('carries both new CHECKs', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ conname: string; convalidated: boolean }>>`
        SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = '"Payment"'::regclass
          AND contype = 'c'
          AND conname IN ('Payment_amendment_not_self', 'Payment_archive_shape')
      `;

      expect(rows.map((row) => row.conname).sort()).toEqual([
        'Payment_amendment_not_self',
        'Payment_archive_shape',
      ]);
      expect(rows.every((row) => row.convalidated)).toBe(true);
    });

    /**
     * A LINKED LIST, NOT A TREE. Without this unique index one voided
     * original could be named by two replacements and "which row is live"
     * would have two answers.
     */
    it('makes the amendment chain a linked list — Payment_replacesPaymentId_key', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'Payment' AND indexname = 'Payment_replacesPaymentId_key'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toContain('UNIQUE');
      expect(rows[0].indexdef).toContain('replacesPaymentId');
    });

    /**
     * ASSERT THE PREDICATE, NOT JUST THE NAME.
     *
     * `Payment_gcash_reference_unique` is what the amend's VOID-before-INSERT
     * ordering depends on: the original leaves the index's predicate the
     * moment it is voided, and only then may the replacement carry the same
     * reference. A name-only assertion would pass against an index whose
     * WHERE clause had lost the `status <> 'VOIDED'` half — and every amend
     * of a GCash payment would 409 at the counter.
     * `StationScan_opening_checkin_once` shipped with exactly that class of
     * mistake.
     */
    it('keeps the GCash reference index PARTIAL on live GCASH rows only', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'Payment' AND indexname = 'Payment_gcash_reference_unique'
      `;
      expect(rows).toHaveLength(1);
      const def = rows[0].indexdef;
      expect(def).toContain('UNIQUE');
      expect(def).toContain('referenceNormalized');
      expect(def).toContain('WHERE');
      expect(def).toContain("'GCASH'");
      expect(def).toContain("'VOIDED'");
    });

    it('restricts both new foreign keys on delete', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
        SELECT conname, confdeltype FROM pg_constraint
        WHERE conrelid = '"Payment"'::regclass
          AND contype = 'f'
          AND conname IN ('Payment_replacesPaymentId_fkey', 'Payment_archivedById_fkey')
      `;

      expect(rows.map((row) => row.conname).sort()).toEqual([
        'Payment_archivedById_fkey',
        'Payment_replacesPaymentId_fkey',
      ]);
      // 'r' = RESTRICT. The original a correction names, and the operator who
      // archived a row, can never be deleted out from under it.
      expect(rows.every((row) => row.confdeltype === 'r')).toBe(true);
    });

    it('rejects a self-referencing amendment — Payment_amendment_not_self', async () => {
      const def = await ctx.prisma.$queryRaw<Array<{ def: string }>>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = '"Payment"'::regclass AND conname = 'Payment_amendment_not_self'
      `;
      expect(def[0].def).toContain('replacesPaymentId');
      expect(def[0].def).toContain('<>');
    });

    it('requires archivedAt and archivedById to move together — Payment_archive_shape', async () => {
      const def = await ctx.prisma.$queryRaw<Array<{ def: string }>>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = '"Payment"'::regclass AND conname = 'Payment_archive_shape'
      `;
      expect(def[0].def).toContain('archivedAt');
      expect(def[0].def).toContain('archivedById');
    });
  });
});
