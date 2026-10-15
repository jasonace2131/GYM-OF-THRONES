import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

const COACH_SUPABASE_ID = '30000000-0000-4000-8000-0000000000c1';
const MEMBER_SUPABASE_ID = '30000000-0000-4000-8000-0000000000d1';
const DESK_SUPABASE_ID = '30000000-0000-4000-8000-0000000000e1';

/** A booking row for a raw INSERT. Every column the CHECKs read is listed; NULL unless given. */
interface BookingValues {
  status: string;
  activeKey: string | null;
  attendedAt?: string | null;
  cancelledAt?: string | null;
  bookedById?: string | null;
  cancelledById?: string | null;
  removalReason?: string | null;
  markedById?: string | null;
  markedAt?: string | null;
}

/** A SQL literal, or NULL. Doubles quotes; control characters go through as themselves. */
const sql = (value: string | null | undefined): string =>
  value === null || value === undefined ? 'NULL' : `'${value.replace(/'/g, "''")}'`;

/**
 * Asserts the CONSTRAINT, not the service. Each insert violates at most one
 * rule, so Postgres names the one under test — and Postgres tests CHECKs in
 * NAME order, which is why each case below satisfies every rule that sorts
 * before the one it breaks.
 *
 * Every CHECK on ClassBooking lives only in hand-written migration SQL
 * (20260826030000_classes_bookings, 20260913000000_class_booking_key_survives_register,
 * 20261011000100_class_booking_actors): a `db push` or a regenerated migration
 * would drop them silently while every service test kept passing.
 */
describe('CHECK constraints — ClassBooking (e2e)', () => {
  let ctx: TestApp;
  let coachId: string;
  let memberId: string;
  let deskId: string;
  let sessionId: string;
  let liveKey: string;

  const insertBooking = (values: BookingValues): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "ClassBooking" (id, "sessionId", "userId", "status", "activeKey", "attendedAt", "cancelledAt",
                                   "bookedById", "cancelledById", "removalReason", "markedById", "markedAt", "updatedAt")
       VALUES (gen_random_uuid(), '${sessionId}', '${memberId}', '${values.status}',
               ${sql(values.activeKey)}, ${sql(values.attendedAt)}, ${sql(values.cancelledAt)},
               ${sql(values.bookedById)}, ${sql(values.cancelledById)}, ${sql(values.removalReason)},
               ${sql(values.markedById)}, ${sql(values.markedAt)},
               now())`,
    );

  /** A desk user taking the member out, with a reason — every rule satisfied but the one varied. */
  const removal = (over: Partial<BookingValues> = {}): BookingValues => ({
    status: 'CANCELLED',
    activeKey: null,
    cancelledAt: '2026-09-15T01:00:00.000Z',
    cancelledById: deskId,
    removalReason: 'Class moved to the small studio',
    ...over,
  });

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);

    await ctx.fixture.tokenFor('COACH', { supabaseId: COACH_SUPABASE_ID });
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: MEMBER_SUPABASE_ID });
    await ctx.fixture.tokenFor('FRONT_DESK', { supabaseId: DESK_SUPABASE_ID });
    coachId = await ctx.fixture.userIdFor(COACH_SUPABASE_ID);
    memberId = await ctx.fixture.userIdFor(MEMBER_SUPABASE_ID);
    deskId = await ctx.fixture.userIdFor(DESK_SUPABASE_ID);

    const session = await ctx.prisma.classSession.create({
      data: {
        title: 'Yoga',
        coachId,
        createdById: coachId,
        startsAt: new Date('2026-09-16T10:00:00.000Z'),
        endsAt: new Date('2026-09-16T11:00:00.000Z'),
        businessDate: new Date('2026-09-16T00:00:00.000Z'),
        capacity: 16,
      },
      select: { id: true },
    });
    sessionId = session.id;
    liveKey = `${sessionId}:${memberId}`;
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "ClassBooking"');
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
    it('carries exactly the ten ClassBooking CHECKs', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = '"ClassBooking"'::regclass AND contype = 'c'
        ORDER BY conname
      `;
      expect(rows.map((row) => row.conname)).toEqual([
        'ClassBooking_active_key_matches',
        'ClassBooking_active_key_shape',
        'ClassBooking_attended_shape',
        'ClassBooking_booker_not_member',
        'ClassBooking_cancelled_shape',
        'ClassBooking_canceller_not_member',
        'ClassBooking_canceller_shape',
        'ClassBooking_marked_shape',
        'ClassBooking_marker_shape',
        'ClassBooking_removal_reason_shape',
      ]);
    });

    it('defines the key shape as "not cancelled", not "booked or waitlisted"', async () => {
      expect(await definitionOf('ClassBooking_active_key_shape')).toContain("<> 'CANCELLED'");
    });

    /**
     * The six actor rules, each EXACTLY as pg_get_constraintdef prints it:
     * every NullTest and comparison in its own parentheses, an IN list as
     * `= ANY (ARRAY[…])`, BETWEEN as `>=` AND `<=` (nested inside the AND it
     * sits in), enum literals cast to "ClassBookingStatus", and the trim set
     * printed as ' \t\r\n'::text — a bare btrim() there would let a reason of
     * tabs and line breaks through as "three characters".
     */
    it.each([
      [
        'ClassBooking_booker_not_member',
        'CHECK ((("bookedById" IS NULL) OR ("bookedById" <> "userId")))',
      ],
      [
        'ClassBooking_canceller_not_member',
        'CHECK ((("cancelledById" IS NULL) OR ("cancelledById" <> "userId")))',
      ],
      [
        'ClassBooking_canceller_shape',
        `CHECK ((("cancelledById" IS NULL) OR (status = 'CANCELLED'::"ClassBookingStatus")))`,
      ],
      [
        'ClassBooking_marked_shape',
        `CHECK ((("markedAt" IS NULL) OR (status = ANY (ARRAY['ATTENDED'::"ClassBookingStatus", 'NO_SHOW'::"ClassBookingStatus"]))))`,
      ],
      ['ClassBooking_marker_shape', 'CHECK ((("markedById" IS NULL) OR ("markedAt" IS NOT NULL)))'],
      [
        'ClassBooking_removal_reason_shape',
        // The \t \r \n below are the real characters, as Postgres prints the
        // constant (same form as ChatMessage_body_length in chat-constraints).
        `CHECK ((("removalReason" IS NULL) OR (("cancelledById" IS NOT NULL) AND ((char_length(btrim("removalReason", ' \t\r\n'::text)) >= 3) AND (char_length(btrim("removalReason", ' \t\r\n'::text)) <= 300)))))`,
      ],
    ])('defines %s', async (name, definition) => {
      expect(await definitionOf(name)).toBe(definition);
    });

    /**
     * 'r' = RESTRICT: a desk user or coach named on a member's booking cannot
     * be hard-deleted from under it. 'c' = CASCADE: the booking goes with its
     * member and with its class.
     */
    it('restricts the three actor FKs and keeps the member and class FKs cascading', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
        SELECT conname, confdeltype FROM pg_constraint
        WHERE contype = 'f' AND conrelid = '"ClassBooking"'::regclass
        ORDER BY conname
      `;
      expect(rows).toEqual([
        { conname: 'ClassBooking_bookedById_fkey', confdeltype: 'r' },
        { conname: 'ClassBooking_cancelledById_fkey', confdeltype: 'r' },
        { conname: 'ClassBooking_markedById_fkey', confdeltype: 'r' },
        { conname: 'ClassBooking_sessionId_fkey', confdeltype: 'c' },
        { conname: 'ClassBooking_userId_fkey', confdeltype: 'c' },
      ]);
    });

    /** ADDITIVE: nullable, no default, so main's old code writes them as NULL. */
    it('adds the five actor columns nullable, with no default', async () => {
      const rows = await ctx.prisma.$queryRaw<
        Array<{
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
        }>
      >`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ClassBooking'
          AND column_name IN ('bookedById', 'cancelledById', 'removalReason', 'markedById', 'markedAt')
        ORDER BY column_name
      `;
      expect(rows).toEqual([
        { column_name: 'bookedById', data_type: 'uuid', is_nullable: 'YES', column_default: null },
        {
          column_name: 'cancelledById',
          data_type: 'uuid',
          is_nullable: 'YES',
          column_default: null,
        },
        {
          column_name: 'markedAt',
          data_type: 'timestamp with time zone',
          is_nullable: 'YES',
          column_default: null,
        },
        { column_name: 'markedById', data_type: 'uuid', is_nullable: 'YES', column_default: null },
        {
          column_name: 'removalReason',
          data_type: 'text',
          is_nullable: 'YES',
          column_default: null,
        },
      ]);
    });
  });

  describe('the booking key', () => {
    it('accepts an ATTENDED row that keeps its key (positive control)', async () => {
      await expect(
        insertBooking({
          status: 'ATTENDED',
          activeKey: liveKey,
          attendedAt: '2026-09-16T10:05:00.000Z',
        }),
      ).resolves.toBe(1);
    });

    it('rejects an ATTENDED row with no key — ClassBooking_active_key_shape', async () => {
      await expect(
        insertBooking({
          status: 'ATTENDED',
          activeKey: null,
          attendedAt: '2026-09-16T10:05:00.000Z',
        }),
      ).rejects.toThrow(/ClassBooking_active_key_shape/);
    });

    it('rejects a second non-cancelled row for the same member and class — the unique key', async () => {
      await insertBooking({
        status: 'ATTENDED',
        activeKey: liveKey,
        attendedAt: '2026-09-16T10:05:00.000Z',
      });
      // Postgres reports the unique violation by SQLSTATE and column, not by
      // index name: `Code: 23505 ... Key ("activeKey")=(…) already exists`.
      // Both halves are stable in a way Prisma's surrounding prose is not.
      await expect(insertBooking({ status: 'BOOKED', activeKey: liveKey })).rejects.toThrow(
        /23505[\s\S]*"activeKey".*already exists/i,
      );
    });

    it('accepts a CANCELLED row beside a live one — cancelled rows release the key', async () => {
      await insertBooking({ status: 'BOOKED', activeKey: liveKey });
      await expect(
        insertBooking({
          status: 'CANCELLED',
          activeKey: null,
          cancelledAt: '2026-09-15T01:00:00.000Z',
        }),
      ).resolves.toBe(1);
    });
  });

  describe('who did it — positive controls', () => {
    // main's old code, both seeds and every row from before the migration
    // leave all five NULL; the rules must hold for them.
    it('accepts rows that record nobody: a booking, a self-cancel, legacy marks', async () => {
      await expect(insertBooking({ status: 'BOOKED', activeKey: liveKey })).resolves.toBe(1);
      await ctx.prisma.$executeRawUnsafe('DELETE FROM "ClassBooking"');
      await expect(
        insertBooking({
          status: 'CANCELLED',
          activeKey: null,
          cancelledAt: '2026-09-15T01:00:00.000Z',
        }),
      ).resolves.toBe(1);
      await expect(
        insertBooking({
          status: 'ATTENDED',
          activeKey: liveKey,
          attendedAt: '2026-09-16T10:05:00.000Z',
        }),
      ).resolves.toBe(1);
      await ctx.prisma.$executeRawUnsafe('DELETE FROM "ClassBooking"');
      await expect(insertBooking({ status: 'NO_SHOW', activeKey: liveKey })).resolves.toBe(1);
    });

    it('accepts a place the desk added by hand', async () => {
      await expect(
        insertBooking({ status: 'BOOKED', activeKey: liveKey, bookedById: deskId }),
      ).resolves.toBe(1);
    });

    it('accepts a desk removal with a reason, at both bounds once trimmed', async () => {
      await expect(insertBooking(removal())).resolves.toBe(1);
      await expect(insertBooking(removal({ removalReason: ' \tabc\r\n ' }))).resolves.toBe(1);
      await expect(insertBooking(removal({ removalReason: 'x'.repeat(300) }))).resolves.toBe(1);
    });

    it('accepts a marked entry, either outcome, with its marker and time', async () => {
      await expect(
        insertBooking({
          status: 'ATTENDED',
          activeKey: liveKey,
          attendedAt: '2026-09-16T10:05:00.000Z',
          markedById: coachId,
          markedAt: '2026-09-16T10:05:00.000Z',
        }),
      ).resolves.toBe(1);
      await ctx.prisma.$executeRawUnsafe('DELETE FROM "ClassBooking"');
      await expect(
        insertBooking({
          status: 'NO_SHOW',
          activeKey: liveKey,
          markedById: deskId,
          markedAt: '2026-09-17T02:00:00.000Z',
        }),
      ).resolves.toBe(1);
    });
  });

  describe('who did it — one rule per insert', () => {
    it('rejects the member as their own booker — ClassBooking_booker_not_member', async () => {
      await expect(
        insertBooking({ status: 'BOOKED', activeKey: liveKey, bookedById: memberId }),
      ).rejects.toThrow(/ClassBooking_booker_not_member/);
    });

    it('rejects the member as their own canceller — ClassBooking_canceller_not_member', async () => {
      await expect(
        insertBooking(removal({ cancelledById: memberId, removalReason: null })),
      ).rejects.toThrow(/ClassBooking_canceller_not_member/);
    });

    it('rejects a canceller on a live booking — ClassBooking_canceller_shape', async () => {
      await expect(
        insertBooking({ status: 'BOOKED', activeKey: liveKey, cancelledById: deskId }),
      ).rejects.toThrow(/ClassBooking_canceller_shape/);
    });

    it('rejects a marking time on an unmarked booking — ClassBooking_marked_shape', async () => {
      await expect(
        insertBooking({
          status: 'BOOKED',
          activeKey: liveKey,
          markedAt: '2026-09-16T10:05:00.000Z',
        }),
      ).rejects.toThrow(/ClassBooking_marked_shape/);
    });

    it('rejects a marker with no time — ClassBooking_marker_shape', async () => {
      await expect(
        insertBooking({
          status: 'ATTENDED',
          activeKey: liveKey,
          attendedAt: '2026-09-16T10:05:00.000Z',
          markedById: coachId,
        }),
      ).rejects.toThrow(/ClassBooking_marker_shape/);
    });

    it.each([
      ['with no canceller named', { cancelledById: null }],
      ['shorter than three characters once trimmed', { removalReason: '  ab  ' }],
      // A bare btrim() would keep these and count them as characters.
      ['of nothing but tabs and line breaks', { removalReason: ' \t\r\n \t' }],
      ['longer than three hundred characters', { removalReason: 'x'.repeat(301) }],
    ])('rejects a removal reason %s — ClassBooking_removal_reason_shape', async (_name, over) => {
      await expect(insertBooking(removal(over))).rejects.toThrow(
        /ClassBooking_removal_reason_shape/,
      );
    });
  });

  /**
   * A desk user is named on one row, in one column, so the only foreign key
   * that can refuse the delete is the one under test. (The coach is not used
   * here: the class's own coachId and createdById FKs would refuse first.)
   */
  describe('RESTRICT on the actors', () => {
    // Factories, so the ids from beforeAll are read when each test runs.
    const rows: Array<[string, () => BookingValues, string]> = [
      [
        'added',
        () => ({ status: 'BOOKED', activeKey: liveKey, bookedById: deskId }),
        'ClassBooking_bookedById_fkey',
      ],
      ['removed', () => removal(), 'ClassBooking_cancelledById_fkey'],
      [
        'marked',
        () => ({
          status: 'NO_SHOW',
          activeKey: liveKey,
          markedById: deskId,
          markedAt: '2026-09-17T02:00:00.000Z',
        }),
        'ClassBooking_markedById_fkey',
      ],
    ];

    it.each(rows)(
      'refuses to hard-delete a desk user who %s a member',
      async (_verb, row, fkey) => {
        await insertBooking(row());

        await expect(
          ctx.prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = '${deskId}'`),
        ).rejects.toThrow(new RegExp(fkey));
      },
    );
  });
});
