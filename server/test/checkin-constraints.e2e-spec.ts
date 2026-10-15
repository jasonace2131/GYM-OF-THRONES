import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';
import { seedStationForTest } from './support/station-fixtures';
import { makeMember, seedPlansForTest } from './support/membership-fixtures';
import { asCivilDate } from '../src/common/time/gym-time';

jest.setTimeout(180_000);

const TODAY = asCivilDate('2026-08-18');

/**
 * Asserts the CONSTRAINTS, not the service.
 *
 * Two jobs, and neither is optional:
 *
 *  1. PRESENCE. Prisma has NO representation of a `CHECK` constraint or a
 *     partial index, so every one of them lives in hand-written migration SQL.
 *     A later `migrate diff`, a `--create-only` regeneration or a local
 *     `db push` drops all of them SILENTLY, and every service test keeps
 *     passing against a schema with no integrity left. These queries are the
 *     only thing that notices.
 *
 *  2. NEGATIVE CASES. Three of the chunk-2 constraints are BICONDITIONAL
 *     (`=`, not `OR`) — `CheckIn_recorder_shape`, `CheckIn_station_shape` and
 *     `CheckInDenial_station_shape`. A one-way implication permits exactly the
 *     row the design forbids: `CHECK (method = 'STATION_QR' OR recordedById IS
 *     NOT NULL)` happily accepts a SELF-SCAN CARRYING A STAFF ID, which is a
 *     lie in a fraud column and passes every test that only inserts the rows
 *     it means to allow. So the forbidden rows go in, by raw SQL, and are
 *     expected to be rejected.
 */
describe('Chunk 2 attendance constraint suite (e2e)', () => {
  let ctx: TestApp;
  let userId: string;
  let membershipId: string;
  let stationId: string;

  const insertCheckIn = (columns: string, values: string): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(`INSERT INTO "CheckIn" (${columns}) VALUES (${values})`);

  const insertDenial = (columns: string, values: string): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(`INSERT INTO "CheckInDenial" (${columns}) VALUES (${values})`);

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await seedPlansForTest(ctx.prisma);

    const member = await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });
    userId = member.userId;
    membershipId = member.membershipId as string;
    stationId = (await seedStationForTest(ctx.prisma)).id;
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "StationScan"');
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "CheckInDenial"');
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "CheckIn"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Presence
  // ───────────────────────────────────────────────────────────────────────

  describe('presence', () => {
    const checksOn = async (table: string): Promise<string[]> => {
      const rows = await ctx.prisma.$queryRawUnsafe<Array<{ conname: string }>>(
        `SELECT conname FROM pg_constraint WHERE conrelid = '"${table}"'::regclass AND contype = 'c'`,
      );
      return rows.map((row) => row.conname).sort();
    };

    /**
     * An EXACT set, not a subset — that is the whole point. `toContain` would
     * pass against a schema a `db push` had silently stripped, which is the
     * failure this file exists to catch (CLAUDE.md: CHECK constraints have no
     * Prisma representation and live only in hand-written migration SQL).
     *
     * The cost is that this list has to be extended in the same commit that
     * adds a constraint. It was not, twice — the four guest-waiver checks
     * arrived with 20260901010000_guest_waiver and
     * `CheckIn_converted_guest_only` with 20260904000000, and this assertion
     * has been red since. A red guard guards nothing, so it is brought back in
     * line here rather than loosened.
     */
    it('carries every CheckIn CHECK the design depends on', async () => {
      expect(await checksOn('CheckIn')).toEqual([
        'CheckIn_autoclosed_agrees',
        'CheckIn_close_station_shape',
        // Only a GUEST visit can convert — a visit that already has an account
        // has nothing to convert into (20260904000000).
        'CheckIn_converted_guest_only',
        'CheckIn_entry_shape',
        // The guest waiver quartet (20260901010000). `_required` is NOT VALID,
        // so pre-existing rows are grandfathered rather than back-filled with
        // invented evidence of consent.
        'CheckIn_guest_emergency_sane',
        'CheckIn_guest_waiver_paired',
        'CheckIn_guest_waiver_required',
        'CheckIn_guest_waiver_sane',
        'CheckIn_open_marker',
        'CheckIn_open_marker_agrees',
        'CheckIn_recorder_shape',
        'CheckIn_reopen_nonneg',
        'CheckIn_shift_shape',
        'CheckIn_station_shape',
        'CheckIn_void_shape',
      ]);
    });

    it('carries every CheckInDenial CHECK', async () => {
      expect(await checksOn('CheckInDenial')).toEqual([
        'CheckInDenial_override_shape',
        'CheckInDenial_recorder_shape',
        'CheckInDenial_resolution_shape',
        'CheckInDenial_shift_required',
        'CheckInDenial_staleness_nonneg',
        'CheckInDenial_staleness_shape',
        'CheckInDenial_station_shape',
      ]);
    });

    it('carries the Station and StationScan CHECKs', async () => {
      expect(await checksOn('Station')).toEqual(['Station_code_shape', 'Station_epoch_positive']);
      expect(await checksOn('StationScan')).toEqual(['StationScan_slot_nonneg']);
    });

    /**
     * The predicate is asserted, not just the name.
     *
     * This index shipped with `'REOPENED'` in its filter, which made §6.6.4's
     * undo path — scan, check out, scan again within twenty minutes — collide
     * on `checkInId` and 500 the member at the counter. A REOPEN IS NOT AN
     * OPENING: the visit it reopens already has an opening scan. Asserting the
     * name alone would not have caught that and would not catch it coming
     * back.
     */
    it('scopes the opening-scan unique index to openings only, never reopens', async () => {
      const [index] = await ctx.prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'StationScan' AND indexname = 'StationScan_opening_checkin_once'
      `;

      expect(index).toBeDefined();
      expect(index.indexdef).toContain('UNIQUE');
      expect(index.indexdef).toContain("'CHECKED_IN'");
      expect(index.indexdef).toContain("'RECHECKED_IN'");
      expect(index.indexdef).not.toContain("'REOPENED'");
    });

    it('keeps the replay claim unique on (userId, stationId, slot)', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'StationScan' AND indexdef LIKE '%UNIQUE%'
      `;
      expect(rows.map((r) => r.indexname)).toContain('StationScan_userId_stationId_slot_key');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // CheckIn — the rows that must not exist
  // ───────────────────────────────────────────────────────────────────────

  describe('CheckIn CHECK constraints', () => {
    const BASE_COLUMNS =
      '"id", "userId", "entryType", "verdict", "membershipId", "membershipStatusAtTime", ' +
      '"occurredAt", "businessDate", "openUserId", "method", "recordedById", "stationId", ' +
      '"stationSlot", "idempotencyKey", "idempotencyHash", "updatedAt"';

    const baseValues = (overrides: Partial<Record<string, string>> = {}): string => {
      const values: Record<string, string> = {
        id: 'gen_random_uuid()',
        userId: `'${userId}'::uuid`,
        entryType: `'MEMBERSHIP'`,
        verdict: `'ALLOWED'`,
        membershipId: `'${membershipId}'::uuid`,
        membershipStatusAtTime: `'ACTIVE'`,
        occurredAt: `now()`,
        businessDate: `DATE '2026-08-18'`,
        openUserId: `'${userId}'::uuid`,
        method: `'STATION_QR'`,
        recordedById: 'NULL',
        stationId: `'${stationId}'::uuid`,
        stationSlot: '1',
        idempotencyKey: `'k-' || gen_random_uuid()`,
        idempotencyHash: `repeat('0', 64)`,
        updatedAt: 'now()',
        ...overrides,
      };
      return Object.values(values).join(', ');
    };

    it('accepts a well-formed self-scan row (positive control)', async () => {
      await expect(insertCheckIn(BASE_COLUMNS, baseValues())).resolves.toBe(1);
    });

    /**
     * THE BICONDITIONAL ONE. A one-way `(method = 'STATION_QR' OR recordedById
     * IS NOT NULL)` accepts this row, and it is a lie: nobody recorded a
     * self-scan, and naming a staff member on one puts an innocent operator's
     * id on an entry they never touched.
     */
    it('rejects a STATION_QR row that names a staff recorder', async () => {
      await expect(
        insertCheckIn(BASE_COLUMNS, baseValues({ recordedById: `'${userId}'::uuid` })),
      ).rejects.toThrow(/CheckIn_recorder_shape/);
    });

    it('rejects a MANUAL row with no recorder', async () => {
      await expect(
        insertCheckIn(
          BASE_COLUMNS,
          baseValues({ method: `'MANUAL'`, stationId: 'NULL', stationSlot: 'NULL' }),
        ),
      ).rejects.toThrow(/CheckIn_recorder_shape|CheckIn_shift_shape/);
    });

    it('rejects a STATION_QR row with no station', async () => {
      await expect(
        insertCheckIn(BASE_COLUMNS, baseValues({ stationId: 'NULL', stationSlot: 'NULL' })),
      ).rejects.toThrow(/CheckIn_station_shape/);
    });

    it('rejects a MEMBERSHIP entry with no membership', async () => {
      await expect(
        insertCheckIn(BASE_COLUMNS, baseValues({ membershipId: 'NULL' })),
      ).rejects.toThrow(/CheckIn_entry_shape/);
    });

    /**
     * "… and cannot be forgotten." Without this, an UPDATE that omits the
     * sentinel leaves a visit open with no sentinel set — invisible to the
     * unique index, and a second visit opens concurrently.
     */
    it('rejects an open visit with no sentinel', async () => {
      await expect(insertCheckIn(BASE_COLUMNS, baseValues({ openUserId: 'NULL' }))).rejects.toThrow(
        /CheckIn_open_marker_agrees/,
      );
    });

    it('rejects a sentinel pointing at someone else', async () => {
      const other = await makeMember(ctx.prisma, { state: 'ACTIVE', today: TODAY });
      await expect(
        insertCheckIn(BASE_COLUMNS, baseValues({ openUserId: `'${other.userId}'::uuid` })),
      ).rejects.toThrow(/CheckIn_open_marker/);
    });

    /**
     * The NULL-propagation trap this constraint was rewritten for: the spec's
     * literal form let `closeMethod IS NULL, autoClosed = true` through,
     * because `FALSE OR NULL` is NULL and a CHECK only rejects on FALSE.
     */
    it('rejects autoClosed = true with no close method', async () => {
      await expect(
        ctx.prisma.$executeRawUnsafe(
          `INSERT INTO "CheckIn" (${BASE_COLUMNS}, "autoClosed") VALUES (${baseValues()}, true)`,
        ),
      ).rejects.toThrow(/CheckIn_autoclosed_agrees/);
    });

    it('rejects a close station stamped on a non-STATION_QR close', async () => {
      await expect(
        ctx.prisma.$executeRawUnsafe(
          `INSERT INTO "CheckIn" (${BASE_COLUMNS}, "endedAt", "closeMethod", "autoClosed", "closeStationId", "closeStationSlot") ` +
            `VALUES (${baseValues({ openUserId: 'NULL' })}, now(), 'STALE_CLOSE', true, '${stationId}'::uuid, 1)`,
        ),
      ).rejects.toThrow(/CheckIn_close_station_shape/);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // CheckInDenial
  // ───────────────────────────────────────────────────────────────────────

  describe('CheckInDenial CHECK constraints', () => {
    const COLUMNS =
      '"id", "userId", "reason", "method", "occurredAt", "businessDate", "stationId", ' +
      '"stationSlot", "tokenStalenessSeconds", "recordedById", "shiftId", "updatedAt"';

    const values = (overrides: Partial<Record<string, string>> = {}): string => {
      const row: Record<string, string> = {
        id: 'gen_random_uuid()',
        userId: `'${userId}'::uuid`,
        reason: `'MEMBERSHIP_EXPIRED'`,
        method: `'STATION_QR'`,
        occurredAt: 'now()',
        businessDate: `DATE '2026-08-18'`,
        stationId: `'${stationId}'::uuid`,
        stationSlot: '1',
        tokenStalenessSeconds: 'NULL',
        recordedById: 'NULL',
        shiftId: 'NULL',
        updatedAt: 'now()',
        ...overrides,
      };
      return Object.values(row).join(', ');
    };

    it('accepts a well-formed self-scan denial (positive control)', async () => {
      await expect(insertDenial(COLUMNS, values())).resolves.toBe(1);
    });

    /**
     * The relay-detection signal. A member 3 s late on a bad connection and one
     * 40 s late off a photograph are the same row without this column — and a
     * STATION_TOKEN_EXPIRED denial with it NULL silently erases the only
     * distribution that separates them.
     */
    it('requires tokenStalenessSeconds exactly for STATION_TOKEN_EXPIRED', async () => {
      await expect(
        insertDenial(COLUMNS, values({ reason: `'STATION_TOKEN_EXPIRED'` })),
      ).rejects.toThrow(/CheckInDenial_staleness_shape/);

      await expect(insertDenial(COLUMNS, values({ tokenStalenessSeconds: '30' }))).rejects.toThrow(
        /CheckInDenial_staleness_shape/,
      );
    });

    it('rejects a negative staleness', async () => {
      await expect(
        insertDenial(
          COLUMNS,
          values({ reason: `'STATION_TOKEN_EXPIRED'`, tokenStalenessSeconds: '-1' }),
        ),
      ).rejects.toThrow(/CheckInDenial_staleness_nonneg/);
    });

    it('rejects a STATION_QR denial that names a staff recorder', async () => {
      await expect(
        insertDenial(COLUMNS, values({ recordedById: `'${userId}'::uuid` })),
      ).rejects.toThrow(/CheckInDenial_recorder_shape/);
    });

    /** A staff action is always reconcilable to a till session. */
    it('requires a shift on a staff-recorded denial', async () => {
      await expect(
        insertDenial(
          COLUMNS,
          values({
            method: `'MANUAL'`,
            stationId: 'NULL',
            stationSlot: 'NULL',
            recordedById: `'${userId}'::uuid`,
          }),
        ),
      ).rejects.toThrow(/CheckInDenial_shift_required/);
    });

    it('keeps outcome and its resolution columns moving together', async () => {
      await expect(
        ctx.prisma.$executeRawUnsafe(
          `INSERT INTO "CheckInDenial" (${COLUMNS}, "outcome") VALUES (${values()}, 'RESOLVED_WALK_IN')`,
        ),
      ).rejects.toThrow(/CheckInDenial_resolution_shape/);
    });

    it('requires an overrider and a reason on an OVERRIDDEN denial', async () => {
      await expect(
        ctx.prisma.$executeRawUnsafe(
          `INSERT INTO "CheckInDenial" (${COLUMNS}, "outcome", "resolvedAt") VALUES (${values()}, 'OVERRIDDEN', now())`,
        ),
      ).rejects.toThrow(/CheckInDenial_override_shape/);
    });
  });
});
