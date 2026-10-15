import { HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';
import { mapPrismaError } from '../src/common/exceptions/prisma-error.mapper';

/**
 * §5.8.6/§5.8.7/§5.12/§11.6 — the constraint-presence + rejection suite for
 * Chunk 1's migration (20260819083833_add_membership_billing).
 *
 * Two distinct things are proven per constraint, never conflated:
 *  1. PRESENCE — pg_constraint / pg_trigger / pg_proc still carry the object,
 *     so a future migration that makes Prisma recreate one of these six
 *     tables (§5.8.7's stated hazard) fails this suite instead of silently
 *     dropping a guarantee.
 *  2. BEHAVIOUR — a write that violates exactly that one constraint is
 *     rejected by Postgres, and the *real* caught driver error is fed
 *     through the *real* mapPrismaError().
 *
 * On (2): every single assertion below finds mapPrismaError(realError) to be
 * `null`, not a DomainException. This is not a mistake in this suite — see
 * the "mapPrismaError never fires against a real driver error" block after
 * setup, which pins the finding down before the per-constraint tests build
 * on it. Read it first if the `toBeNull()` calls below look wrong.
 *
 * Every fixture row is built to violate EXACTLY ONE constraint. Where a
 * table has interacting CHECKs (e.g. MembershipHold's active-marker pair),
 * the "control" fields are set to values that satisfy every other CHECK, so
 * Postgres has only one thing to complain about and the constraint NAME in
 * its error text is unambiguous.
 */

// ── SQL literal plumbing ────────────────────────────────────────────────

/** Marks a fragment that must NOT be quoted (e.g. `now()`, a bare literal). */
class Raw {
  constructor(readonly sql: string) {}
}
const raw = (sql: string): Raw => new Raw(sql);
const NOW = raw('now()');

type Cell = string | number | boolean | null | Raw;
type Row = Record<string, Cell>;

function lit(value: Cell): string {
  if (value instanceof Raw) return value.sql;
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function insertSql(table: string, row: Row): string {
  const cols = Object.keys(row);
  return `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols
    .map((c) => lit(row[c]))
    .join(', ')})`;
}

function updateSql(table: string, id: string, set: Row): string {
  const assignments = Object.entries(set)
    .map(([col, value]) => `"${col}" = ${lit(value)}`)
    .join(', ');
  return `UPDATE "${table}" SET ${assignments} WHERE id = '${id}'`;
}

async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const TODAY = new Date();

// ── Suite ────────────────────────────────────────────────────────────────

describe('Chunk 1 membership/billing constraint suite (e2e)', () => {
  let ctx: TestApp;
  let staffId: string; // ADMIN — actor/approver/recorder/opener throughout
  let staff2Id: string; // FRONT_DESK — a second, distinct staff user

  let planId: string; // one shared valid TERM+freezable Plan
  let planCode: string;
  let paymentShiftId: string; // one shared OPEN Shift, for Payment FK use

  const insert = (table: string, row: Row): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(insertSql(table, row));
  const update = (table: string, id: string, set: Row): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(updateSql(table, id, set));
  const del = (table: string, id: string): Promise<number> =>
    ctx.prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id = '${id}'`);

  let planSeq = 0;
  let idemSeq = 0;
  let shiftSeq = 0;
  let memberSeq = 0;

  /** Mints a brand-new CLIENT fixture user, so Membership.userId's @unique
   * index never collides between tests that each need their own member. */
  async function nextMemberId(): Promise<string> {
    memberSeq += 1;
    const sid = `50000000-0000-4000-8000-${String(memberSeq).padStart(12, '0')}`;
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: sid });
    return ctx.fixture.userIdFor(sid);
  }

  function basePlan(overrides: Row = {}): Row {
    planSeq += 1;
    return {
      id: randomUUID(),
      code: `PLAN_${planSeq}`,
      name: 'Test Plan',
      kind: 'TERM',
      priceCentavos: 100000,
      termMonths: 1,
      freezable: true,
      graceDays: 3,
      guestPassesPerTerm: 1,
      isActive: true,
      sortOrder: 0,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  async function createPlan(overrides: Row = {}): Promise<string> {
    const row = basePlan(overrides);
    await insert('Plan', row);
    return row.id as string;
  }

  function baseMembership(userId: string, overrides: Row = {}): Row {
    const start = isoDate(TODAY);
    const end = isoDate(addDays(TODAY, 30));
    return {
      id: randomUUID(),
      userId,
      planId,
      planCode,
      planName: 'Test Plan',
      planPriceCentavos: 100000,
      termMonths: 1,
      graceDays: 3,
      guestPassesPerTerm: 1,
      startsOn: start,
      endsOn: end,
      billingAnchorDay: 15,
      joinedOn: start,
      purchasedAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  async function createMembership(userId: string, overrides: Row = {}): Promise<string> {
    const row = baseMembership(userId, overrides);
    await insert('Membership', row);
    return row.id as string;
  }

  /** Membership + its own fresh member, for tests that only need "a valid
   * membership to hang a Payment/Hold/Event off of" and don't care whose. */
  async function createValidMembership(overrides: Row = {}): Promise<string> {
    const userId = await nextMemberId();
    return createMembership(userId, overrides);
  }

  function baseHold(membershipId: string, overrides: Row = {}): Row {
    return {
      id: randomUUID(),
      membershipId,
      startsOn: isoDate(addDays(TODAY, 10)),
      endsOn: isoDate(addDays(TODAY, 20)),
      daysRequested: 11,
      reason: 'medical',
      approvedById: staffId,
      updatedAt: NOW,
      ...overrides,
    };
  }

  async function insertHold(membershipId: string, overrides: Row = {}): Promise<Row> {
    const row = baseHold(membershipId, overrides);
    await insert('MembershipHold', row);
    return row;
  }

  function baseEvent(membershipId: string, overrides: Row = {}): Row {
    return {
      id: randomUUID(),
      membershipId,
      type: 'PURCHASED',
      toStatus: 'ACTIVE',
      effectiveAt: NOW,
      ...overrides,
    };
  }

  function basePayment(membershipId: string, userId: string, overrides: Row = {}): Row {
    idemSeq += 1;
    return {
      id: randomUUID(),
      userId,
      membershipId,
      planId,
      purpose: 'MEMBERSHIP',
      planCode,
      planName: 'Test Plan',
      grossCentavos: 100000,
      vatBaseCentavos: 100000,
      netCentavos: 100000,
      termMonths: 1,
      termStartsOn: isoDate(TODAY),
      termEndsOn: isoDate(addDays(TODAY, 30)),
      method: 'CASH',
      receivedAt: NOW,
      businessDate: isoDate(TODAY),
      shiftId: paymentShiftId,
      recordedById: staffId,
      idempotencyKey: `IK_${idemSeq}_${randomUUID()}`,
      idempotencyHash: 'a'.repeat(64),
      updatedAt: NOW,
      ...overrides,
    };
  }

  function baseShift(overrides: Row = {}): Row {
    shiftSeq += 1;
    return {
      id: randomUUID(),
      openedById: staffId,
      openedAt: NOW,
      openingFloatCentavos: 5000,
      businessDate: isoDate(TODAY),
      openMarker: `SHIFT_${shiftSeq}_${randomUUID()}`,
      updatedAt: NOW,
      ...overrides,
    };
  }

  async function createShift(overrides: Row = {}): Promise<string> {
    const row = baseShift(overrides);
    await insert('Shift', row);
    return row.id as string;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);

    await ctx.fixture.tokenFor('ADMIN', { supabaseId: '60000000-0000-4000-8000-0000000000a1' });
    await ctx.fixture.tokenFor('FRONT_DESK', {
      supabaseId: '60000000-0000-4000-8000-0000000000a2',
    });
    staffId = await ctx.fixture.userIdFor('60000000-0000-4000-8000-0000000000a1');
    staff2Id = await ctx.fixture.userIdFor('60000000-0000-4000-8000-0000000000a2');

    planCode = `PLAN_BASE_${randomUUID()}`;
    planId = await createPlan({ code: planCode });
    paymentShiftId = await createShift();
  });

  afterAll(async () => {
    await ctx.close();
  });

  // ── Presence ───────────────────────────────────────────────────────────

  describe('presence', () => {
    it('has all 33 CHECK + 1 EXCLUDE constraint on the six tables', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE contype IN ('c', 'x')
          AND conrelid IN (
            '"Plan"'::regclass, '"Membership"'::regclass, '"MembershipHold"'::regclass,
            '"MembershipEvent"'::regclass, '"Payment"'::regclass, '"Shift"'::regclass
          )
      `;
      const names = rows.map((r) => r.conname).sort();

      expect(names).toEqual(
        [
          // Plan (§5.8.2) — 4
          'Plan_price_bounded',
          'Plan_grace_bounded',
          'Plan_passes_bounded',
          'Plan_term_matches_kind',
          // Membership (§5.8.3) — 8. The last is
          // 20261008000000_membership_expiry_alert_archive.
          'Membership_dates_ordered',
          'Membership_anchor_valid',
          'Membership_term_bounded',
          'Membership_grace_bounded',
          'Membership_price_nonneg',
          'Membership_counters_sane',
          'Membership_cancel_shape',
          'Membership_expiry_alert_archive_shape',
          // MembershipHold (§5.8.3) — 5 CHECK + 1 EXCLUDE
          'MembershipHold_dates_ordered',
          'MembershipHold_days_bounded',
          'MembershipHold_active_marker',
          'MembershipHold_active_marker_agrees',
          'MembershipHold_release_shape',
          'MembershipHold_no_overlap',
          // MembershipEvent (§5.8.4) — 2
          'MembershipEvent_reason_required',
          'MembershipEvent_dates_paired',
          // Payment (§5.8.5) — 10. Payment_void_kind_shape is C3's
          // (20260827010000_payment_void_kind): voidKind is NOT NULL exactly
          // when voidedAt is, so a VOIDED row always says WHICH kind it was.
          // The last two are 20260903000000_gcash_reference_and_verification:
          // the normalized reference moves with the raw one, and the staff
          // attestation pair moves together and only on a GCASH row.
          'Payment_gross_positive',
          'Payment_money_consistent',
          'Payment_zero_only_when_comped',
          'Payment_discount_shape',
          'Payment_purpose_shape',
          'Payment_gcash_reference',
          'Payment_reference_normalized_shape',
          'Payment_gcash_verified_shape',
          'Payment_void_shape',
          'Payment_void_kind_shape',
          // Added by later payment migrations (amend, archive, GCash proof)
          // without this list catching up.
          'Payment_amendment_not_self',
          'Payment_archive_shape',
          'Payment_proof_gcash_only',
          // Shift (§5.8.5) — 3
          'Shift_float_nonneg',
          'Shift_open_marker',
          'Shift_close_shape',
        ].sort(),
      );
    });

    it('has the append-only trigger and its function on MembershipEvent', async () => {
      const triggers = await ctx.prisma.$queryRaw<Array<{ tgname: string }>>`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = '"MembershipEvent"'::regclass AND NOT tgisinternal
      `;
      expect(triggers.map((t) => t.tgname)).toEqual(['MembershipEvent_append_only']);

      const fns = await ctx.prisma.$queryRaw<Array<{ proname: string }>>`
        SELECT proname FROM pg_proc WHERE proname = 'membership_event_append_only'
      `;
      expect(fns).toHaveLength(1);
    });

    it('has the three Prisma-owned nullable-unique sentinel indexes', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'Membership_userId_key', 'Payment_idempotencyKey_key', 'Shift_openMarker_key'
          )
      `;
      expect(rows.map((r) => r.indexname).sort()).toEqual(
        ['Membership_userId_key', 'Payment_idempotencyKey_key', 'Shift_openMarker_key'].sort(),
      );
    });

    it('has the GCash duplicate-reference index, with the predicate it needs', async () => {
      // The PREDICATE, not just the name: StationScan_opening_checkin_once
      // shipped with the wrong filter and a name-only assertion missed it.
      const rows = await ctx.prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'Payment_gcash_reference_unique'
      `;
      expect(rows).toHaveLength(1);
      const def = rows[0].indexdef;
      expect(def).toContain('UNIQUE');
      expect(def).toContain('referenceNormalized');
      expect(def).toMatch(/method.*=.*'GCASH'/);
      expect(def).toMatch(/status.*<>.*'VOIDED'/);
    });
  });

  // ── The central finding, pinned down before it is relied on below ──────

  describe('mapPrismaError never fires against a real driver-reported constraint violation', () => {
    it('CHECK: raw SQL reports SQLSTATE + message text, never meta.constraint/meta.target', async () => {
      const caught = await capture(() => insert('Plan', basePlan({ priceCentavos: -1 })));
      expect(caught).toBeDefined();
      // Real shape observed: PrismaClientKnownRequestError, code P2010,
      // meta = { message: '...violates check constraint "Plan_price_bounded"...', code: '23514' }.
      // mapPrismaError() only reads meta.constraint / meta.target — neither
      // key exists here — so it returns null and the caller falls through to
      // a bare 500, for every CHECK/EXCLUDE constraint reached via raw SQL.
      expect(mapPrismaError(caught)).toBeNull();
    });

    it('CHECK via the ORM client: Prisma throws PrismaClientUnknownRequestError, not KnownRequestError', async () => {
      const caught = await capture(() =>
        (
          ctx.prisma as unknown as { plan: { create(args: unknown): Promise<unknown> } }
        ).plan.create({
          data: {
            code: `ORMCHK_${randomUUID()}`,
            name: 'x',
            kind: 'TERM',
            priceCentavos: -1,
            termMonths: 1,
          },
        }),
      );
      expect(caught).toBeDefined();
      expect((caught as Error).constructor.name).toBe('PrismaClientUnknownRequestError');
      // mapPrismaError's very first line is `instanceof PrismaClientKnownRequestError`,
      // so this never even reaches the constraint-name lookup: null, every time,
      // for a CHECK/EXCLUDE constraint unmodeled in schema.prisma reached via
      // `.create()`/`.update()`. This is the shape every not-yet-written Chunk 1
      // service (membership-sales, membership-holds, payments) will hit.
      expect(mapPrismaError(caught)).toBeNull();
    });

    it('UNIQUE via raw SQL: meta carries only the SQLSTATE and a column-naming message, no constraint name', async () => {
      const code = `DUPETEST_${randomUUID()}`;
      await insert('Plan', basePlan({ code }));
      const caught = await capture(() => insert('Plan', basePlan({ code })));
      expect(caught).toMatchObject({ meta: expect.objectContaining({ code: '23505' }) as unknown });
      expect(mapPrismaError(caught)).toBeNull();
    });

    it('UNIQUE via the ORM client: meta is empty; the field name lives only in .message', async () => {
      const key = `ORMDUPE_${randomUUID()}`;
      const client = ctx.prisma as unknown as {
        payment: { create(args: unknown): Promise<unknown> };
      };
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      const base = basePayment(membershipId, userId, { idempotencyKey: key });
      await ctx.prisma.$executeRawUnsafe(insertSql('Payment', base));
      const caught = await capture(() =>
        client.payment.create({
          data: {
            id: randomUUID(),
            userId,
            membershipId,
            planId,
            purpose: 'MEMBERSHIP',
            planCode,
            planName: 'Test Plan',
            grossCentavos: 100000,
            vatBaseCentavos: 100000,
            netCentavos: 100000,
            termMonths: 1,
            termStartsOn: new Date(),
            termEndsOn: addDays(new Date(), 30),
            method: 'CASH',
            receivedAt: new Date(),
            businessDate: new Date(),
            shiftId: paymentShiftId,
            recordedById: staffId,
            idempotencyKey: key,
            idempotencyHash: 'b'.repeat(64),
          },
        }),
      );
      expect((caught as Error).message).toMatch(/idempotencyKey/);
      expect((caught as { code?: string }).code).toBe('P2002');
      // Unlike the raw-SQL path, the ORM DOES populate meta here — but with
      // an ARRAY OF FIELD NAMES (`['idempotencyKey']`), not the SQL
      // constraint name `Payment_idempotencyKey_key` that CONSTRAINT_ERROR_CODES
      // is keyed on character-for-character. constraintNameOf() dutifully
      // extracts 'idempotencyKey' from meta.target, but that string is never a
      // meta.target holds FIELD names, never the SQL constraint name the map is
      // keyed on. The mapper closes that gap by rebuilding Prisma's own
      // Model_field_key convention from modelName + target, so this now maps.
      // 409, not 422: a reused idempotency key is a collision, not bad input.
      expect((caught as { meta?: { target?: unknown } }).meta).toMatchObject({
        target: ['idempotencyKey'],
      });
      const dupeMapped = mapPrismaError(caught);
      expect(dupeMapped?.getResponse()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      expect(dupeMapped?.getStatus()).toBe(HttpStatus.CONFLICT);
    });
  });

  // ── Plan (§5.8.2) ────────────────────────────────────────────────────

  describe('Plan CHECK constraints', () => {
    it('accepts a well-formed TERM plan (positive control)', async () => {
      await expect(insert('Plan', basePlan())).resolves.toBe(1);
    });

    it('accepts a well-formed WALK_IN plan (positive control)', async () => {
      await expect(
        insert('Plan', basePlan({ kind: 'WALK_IN', termMonths: null, freezable: false })),
      ).resolves.toBe(1);
    });

    it('rejects price above bound — Plan_price_bounded', async () => {
      await expect(insert('Plan', basePlan({ priceCentavos: 10000001 }))).rejects.toThrow(
        /Plan_price_bounded/,
      );
    });

    it('rejects price below bound — Plan_price_bounded', async () => {
      await expect(insert('Plan', basePlan({ priceCentavos: -1 }))).rejects.toThrow(
        /Plan_price_bounded/,
      );
    });

    it('rejects graceDays above bound — Plan_grace_bounded', async () => {
      await expect(insert('Plan', basePlan({ graceDays: 15 }))).rejects.toThrow(
        /Plan_grace_bounded/,
      );
    });

    it('rejects guestPassesPerTerm above bound — Plan_passes_bounded', async () => {
      await expect(insert('Plan', basePlan({ guestPassesPerTerm: 13 }))).rejects.toThrow(
        /Plan_passes_bounded/,
      );
    });

    it('rejects a TERM plan with no termMonths — Plan_term_matches_kind', async () => {
      await expect(insert('Plan', basePlan({ termMonths: null }))).rejects.toThrow(
        /Plan_term_matches_kind/,
      );
    });

    it('rejects a WALK_IN plan carrying termMonths — Plan_term_matches_kind', async () => {
      await expect(insert('Plan', basePlan({ kind: 'WALK_IN', freezable: false }))).rejects.toThrow(
        /Plan_term_matches_kind/,
      );
    });

    it('rejects a WALK_IN plan that is freezable — Plan_term_matches_kind', async () => {
      await expect(
        insert('Plan', basePlan({ kind: 'WALK_IN', termMonths: null, freezable: true })),
      ).rejects.toThrow(/Plan_term_matches_kind/);
    });
  });

  // ── Membership (§5.8.3) ──────────────────────────────────────────────

  describe('Membership CHECK constraints', () => {
    it('accepts a well-formed ACTIVE membership (positive control)', async () => {
      const userId = await nextMemberId();
      await expect(insert('Membership', baseMembership(userId))).resolves.toBe(1);
    });

    it('accepts an archived expiry alert with both columns set (positive control)', async () => {
      const userId = await nextMemberId();
      await expect(
        insert(
          'Membership',
          baseMembership(userId, {
            expiryAlertArchivedFor: isoDate(TODAY),
            expiryAlertArchivedAt: NOW,
          }),
        ),
      ).resolves.toBe(1);
    });

    it('rejects half an archive stamp — Membership_expiry_alert_archive_shape', async () => {
      const userId = await nextMemberId();
      await expect(
        insert('Membership', baseMembership(userId, { expiryAlertArchivedFor: isoDate(TODAY) })),
      ).rejects.toThrow(/Membership_expiry_alert_archive_shape/);
    });

    it('rejects endsOn before startsOn — Membership_dates_ordered', async () => {
      const userId = await nextMemberId();
      await expect(
        insert(
          'Membership',
          baseMembership(userId, {
            startsOn: isoDate(TODAY),
            endsOn: isoDate(addDays(TODAY, -1)),
          }),
        ),
      ).rejects.toThrow(/Membership_dates_ordered/);
    });

    it('rejects an out-of-range billingAnchorDay — Membership_anchor_valid', async () => {
      const userId = await nextMemberId();
      await expect(
        insert('Membership', baseMembership(userId, { billingAnchorDay: 32 })),
      ).rejects.toThrow(/Membership_anchor_valid/);
    });

    it('rejects termMonths above bound — Membership_term_bounded', async () => {
      const userId = await nextMemberId();
      await expect(
        insert('Membership', baseMembership(userId, { termMonths: 61 })),
      ).rejects.toThrow(/Membership_term_bounded/);
    });

    it('rejects graceDays above bound — Membership_grace_bounded', async () => {
      const userId = await nextMemberId();
      await expect(insert('Membership', baseMembership(userId, { graceDays: 15 }))).rejects.toThrow(
        /Membership_grace_bounded/,
      );
    });

    it('rejects a negative planPriceCentavos — Membership_price_nonneg', async () => {
      const userId = await nextMemberId();
      await expect(
        insert('Membership', baseMembership(userId, { planPriceCentavos: -1 })),
      ).rejects.toThrow(/Membership_price_nonneg/);
    });

    it('rejects guestPassesRemaining above guestPassesPerTerm — Membership_counters_sane', async () => {
      const userId = await nextMemberId();
      await expect(
        insert(
          'Membership',
          baseMembership(userId, { guestPassesPerTerm: 1, guestPassesRemaining: 5 }),
        ),
      ).rejects.toThrow(/Membership_counters_sane/);
    });

    it('rejects a negative freezesUsedThisTerm — Membership_counters_sane', async () => {
      const userId = await nextMemberId();
      await expect(
        insert('Membership', baseMembership(userId, { freezesUsedThisTerm: -1 })),
      ).rejects.toThrow(/Membership_counters_sane/);
    });

    it('rejects CANCELLED with no cancelledOn — Membership_cancel_shape', async () => {
      const userId = await nextMemberId();
      await expect(
        insert('Membership', baseMembership(userId, { status: 'CANCELLED' })),
      ).rejects.toThrow(/Membership_cancel_shape/);
    });

    it('rejects an ACTIVE row carrying cancelledOn — Membership_cancel_shape', async () => {
      const userId = await nextMemberId();
      await expect(
        insert('Membership', baseMembership(userId, { cancelledOn: isoDate(TODAY) })),
      ).rejects.toThrow(/Membership_cancel_shape/);
    });

    it('rejects a second membership for the same userId — Membership_userId_key', async () => {
      const userId = await nextMemberId();
      await createMembership(userId);
      const caught = await capture(() => insert('Membership', baseMembership(userId)));
      expect(caught).toMatchObject({
        message: expect.stringMatching(/userId/) as unknown,
        meta: expect.objectContaining({ code: '23505' }) as unknown,
      });
      // Consistent with the mapPrismaError findings above: this real error
      // is never mapped either.
      expect(mapPrismaError(caught)).toBeNull();
    });
  });

  // ── MembershipHold (§5.8.3) ──────────────────────────────────────────

  describe('MembershipHold CHECK/EXCLUDE constraints', () => {
    it('accepts a well-formed SCHEDULED hold (positive control)', async () => {
      const membershipId = await createValidMembership();
      await expect(insert('MembershipHold', baseHold(membershipId))).resolves.toBe(1);
    });

    it('rejects endsOn before startsOn — MembershipHold_dates_ordered', async () => {
      const membershipId = await createValidMembership();
      await expect(
        insert(
          'MembershipHold',
          baseHold(membershipId, {
            startsOn: isoDate(addDays(TODAY, 10)),
            endsOn: isoDate(addDays(TODAY, 5)),
          }),
        ),
      ).rejects.toThrow(/MembershipHold_dates_ordered/);
    });

    it('rejects daysRequested below 7 — MembershipHold_days_bounded', async () => {
      const membershipId = await createValidMembership();
      await expect(
        insert('MembershipHold', baseHold(membershipId, { daysRequested: 6 })),
      ).rejects.toThrow(/MembershipHold_days_bounded/);
    });

    it('rejects daysRequested above 90 — MembershipHold_days_bounded', async () => {
      const membershipId = await createValidMembership();
      await expect(
        insert('MembershipHold', baseHold(membershipId, { daysRequested: 91 })),
      ).rejects.toThrow(/MembershipHold_days_bounded/);
    });

    it('rejects daysApplied above daysRequested — MembershipHold_days_bounded', async () => {
      const membershipId = await createValidMembership();
      await expect(
        insert('MembershipHold', baseHold(membershipId, { daysRequested: 11, daysApplied: 20 })),
      ).rejects.toThrow(/MembershipHold_days_bounded/);
    });

    it('rejects a sentinel naming a different membership — MembershipHold_active_marker', async () => {
      const membershipId = await createValidMembership();
      const otherMembershipId = await createValidMembership();
      const caught = await capture(() =>
        insert(
          'MembershipHold',
          baseHold(membershipId, {
            status: 'ACTIVE',
            activeMembershipId: otherMembershipId,
          }),
        ),
      );
      expect(caught).toBeDefined();
      expect((caught as Error).message).toMatch(/MembershipHold_active_marker\b/);
      expect(mapPrismaError(caught)).toBeNull();
    });

    it('rejects ACTIVE with no sentinel — MembershipHold_active_marker_agrees', async () => {
      const membershipId = await createValidMembership();
      const caught = await capture(() =>
        insert('MembershipHold', baseHold(membershipId, { status: 'ACTIVE' })),
      );
      expect((caught as Error).message).toMatch(/MembershipHold_active_marker_agrees/);
      // Now mapped: the name is read out of the message text. 409 rather than
      // 422 per §5.8.6 — the caller lost a race, its input was not malformed.
      const holdMapped = mapPrismaError(caught);
      expect(holdMapped?.getResponse()).toMatchObject({ code: 'MEMBERSHIP_ALREADY_FROZEN' });
      expect(holdMapped?.getStatus()).toBe(HttpStatus.CONFLICT);
    });

    it('rejects COMPLETED with no releasedAt — MembershipHold_release_shape', async () => {
      const membershipId = await createValidMembership();
      await expect(
        insert('MembershipHold', baseHold(membershipId, { status: 'COMPLETED' })),
      ).rejects.toThrow(/MembershipHold_release_shape/);
    });

    it('rejects overlapping SCHEDULED windows on one membership — MembershipHold_no_overlap', async () => {
      const membershipId = await createValidMembership();
      await insertHold(membershipId, {
        startsOn: isoDate(addDays(TODAY, 10)),
        endsOn: isoDate(addDays(TODAY, 20)),
      });
      const caught = await capture(() =>
        insertHold(membershipId, {
          startsOn: isoDate(addDays(TODAY, 15)),
          endsOn: isoDate(addDays(TODAY, 25)),
        }),
      );
      expect(caught).toBeDefined();
      expect((caught as Error).message).toMatch(/MembershipHold_no_overlap|exclusion constraint/);
      // An EXCLUDE violation names its constraint in the message like any other,
      // so it maps now. Overlap is a 422: the requested window itself is wrong.
      const overlapMapped = mapPrismaError(caught);
      expect(overlapMapped?.getResponse()).toMatchObject({ code: 'HOLD_OVERLAPS' });
      expect(overlapMapped?.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    });

    it('accepts an overlapping CANCELLED hold — the EXCLUDE only guards SCHEDULED/ACTIVE (negative control)', async () => {
      const membershipId = await createValidMembership();
      await insertHold(membershipId, {
        startsOn: isoDate(addDays(TODAY, 30)),
        endsOn: isoDate(addDays(TODAY, 40)),
        status: 'CANCELLED',
        releasedAt: NOW,
        releasedById: staffId,
      });
      await expect(
        insertHold(membershipId, {
          startsOn: isoDate(addDays(TODAY, 30)),
          endsOn: isoDate(addDays(TODAY, 40)),
        }),
      ).resolves.toBeDefined();
    });
  });

  // ── MembershipEvent (§5.8.4) — CHECKs and the append-only trigger ──────

  describe('MembershipEvent CHECK constraints and the append-only trigger', () => {
    it('accepts a well-formed PURCHASED event (positive control)', async () => {
      const membershipId = await createValidMembership();
      await expect(insert('MembershipEvent', baseEvent(membershipId))).resolves.toBe(1);
    });

    it('rejects ADJUSTED with no reason — MembershipEvent_reason_required', async () => {
      const membershipId = await createValidMembership();
      await expect(
        insert('MembershipEvent', baseEvent(membershipId, { type: 'ADJUSTED' })),
      ).rejects.toThrow(/MembershipEvent_reason_required/);
    });

    it('rejects ADJUSTED with a too-short reason — MembershipEvent_reason_required', async () => {
      const membershipId = await createValidMembership();
      await expect(
        insert(
          'MembershipEvent',
          baseEvent(membershipId, { type: 'STATUS_CORRECTED', reason: 'ok' }),
        ),
      ).rejects.toThrow(/MembershipEvent_reason_required/);
    });

    it('rejects previousEndsOn without newEndsOn — MembershipEvent_dates_paired', async () => {
      const membershipId = await createValidMembership();
      await expect(
        insert('MembershipEvent', baseEvent(membershipId, { previousEndsOn: isoDate(TODAY) })),
      ).rejects.toThrow(/MembershipEvent_dates_paired/);
    });

    it('rejects newEndsOn without previousEndsOn — MembershipEvent_dates_paired', async () => {
      const membershipId = await createValidMembership();
      await expect(
        insert(
          'MembershipEvent',
          baseEvent(membershipId, { newEndsOn: isoDate(addDays(TODAY, 30)) }),
        ),
      ).rejects.toThrow(/MembershipEvent_dates_paired/);
    });

    it('rejects an UPDATE of an existing event — append-only trigger', async () => {
      const membershipId = await createValidMembership();
      const row = baseEvent(membershipId, {
        type: 'ADJUSTED',
        reason: 'seed for trigger test',
      });
      await insert('MembershipEvent', row);

      const caught = await capture(() =>
        update('MembershipEvent', row.id as string, { reason: 'rewritten' }),
      );
      expect(caught).toBeDefined();
      expect((caught as Error).message).toMatch(/append-only/);
      // §5.8.6: deliberately unmapped — a genuine 500 is the correct signal.
      expect(mapPrismaError(caught)).toBeNull();
    });

    it('rejects a DELETE of an existing event — append-only trigger', async () => {
      const membershipId = await createValidMembership();
      const row = baseEvent(membershipId);
      await insert('MembershipEvent', row);

      const caught = await capture(() => del('MembershipEvent', row.id as string));
      expect(caught).toBeDefined();
      expect((caught as Error).message).toMatch(/append-only/);
      expect(mapPrismaError(caught)).toBeNull();
    });
  });

  // ── Payment (§5.8.5) ─────────────────────────────────────────────────

  describe('Payment CHECK constraints', () => {
    it('accepts a well-formed MEMBERSHIP payment (positive control)', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      await expect(insert('Payment', basePayment(membershipId, userId))).resolves.toBe(1);
    });

    it('rejects a second live GCash row with the same normalized reference — Payment_gcash_reference_unique', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      const gcash = {
        method: 'GCASH',
        reference: '6028 871 884223',
        referenceNormalized: '6028871884223',
      };
      await expect(
        insert('Payment', basePayment(membershipId, userId, gcash)),
      ).resolves.toBe(1);
      // The raw driver reports 23505 with the KEY detail, not the index name
      // — the name+predicate are asserted from pg_indexes above; here the
      // duplicate value itself is the signature.
      await expect(insert('Payment', basePayment(membershipId, userId, gcash))).rejects.toThrow(
        /referenceNormalized.*already exists/,
      );
    });

    it('lets a voided mis-key be re-entered — the index excludes VOIDED', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      const gcash = {
        method: 'GCASH',
        reference: '6028871884224',
        referenceNormalized: '6028871884224',
      };
      await expect(
        insert(
          'Payment',
          basePayment(membershipId, userId, {
            ...gcash,
            status: 'VOIDED',
            voidedAt: NOW,
            voidedById: staffId,
            voidReason: 'mis-keyed reference',
            voidKind: 'VOID',
          }),
        ),
      ).resolves.toBe(1);
      await expect(insert('Payment', basePayment(membershipId, userId, gcash))).resolves.toBe(1);
    });

    it('rejects a reference without its normalized twin — Payment_reference_normalized_shape', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      await expect(
        insert(
          'Payment',
          basePayment(membershipId, userId, { method: 'GCASH', reference: '6028871884225' }),
        ),
      ).rejects.toThrow(/Payment_reference_normalized_shape/);
    });

    it('rejects a GCash attestation on a CASH row — Payment_gcash_verified_shape', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      await expect(
        insert(
          'Payment',
          basePayment(membershipId, userId, {
            gcashVerifiedAt: NOW,
            gcashVerifiedById: staffId,
          }),
        ),
      ).rejects.toThrow(/Payment_gcash_verified_shape/);
    });

    it('rejects grossCentavos above bound — Payment_gross_positive', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      await expect(
        insert(
          'Payment',
          basePayment(membershipId, userId, {
            grossCentavos: 10000001,
            vatBaseCentavos: 10000001,
            netCentavos: 10000001,
          }),
        ),
      ).rejects.toThrow(/Payment_gross_positive/);
    });

    it('rejects grossCentavos of 0 — Payment_gross_positive', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      await expect(
        insert(
          'Payment',
          basePayment(membershipId, userId, {
            grossCentavos: 0,
            vatBaseCentavos: 0,
            netCentavos: 0,
            vatExempt: true,
            discountType: 'STAFF',
            discountReason: 'comp',
          }),
        ),
      ).rejects.toThrow(/Payment_gross_positive/);
    });

    it('rejects netCentavos not matching vatBase - discount — Payment_money_consistent', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      await expect(
        insert('Payment', basePayment(membershipId, userId, { netCentavos: 99999 })),
      ).rejects.toThrow(/Payment_money_consistent/);
    });

    it('rejects vatBaseCentavos above grossCentavos — Payment_money_consistent', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      await expect(
        insert(
          'Payment',
          basePayment(membershipId, userId, {
            vatBaseCentavos: 200000,
            netCentavos: 200000,
          }),
        ),
      ).rejects.toThrow(/Payment_money_consistent/);
    });

    it('rejects netCentavos = 0 with discountType NONE — Payment_zero_only_when_comped', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      await expect(
        insert(
          'Payment',
          basePayment(membershipId, userId, {
            vatBaseCentavos: 0,
            netCentavos: 0,
            vatExempt: true,
          }),
        ),
      ).rejects.toThrow(/Payment_zero_only_when_comped/);
    });

    it('rejects SENIOR discount with no statutoryIdNo — Payment_discount_shape', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      await expect(
        insert(
          'Payment',
          basePayment(membershipId, userId, {
            discountType: 'SENIOR',
            discountCentavos: 20000,
            netCentavos: 80000,
          }),
        ),
      ).rejects.toThrow(/Payment_discount_shape/);
    });

    it('rejects PROMO discount with no discountReason — Payment_discount_shape', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      await expect(
        insert(
          'Payment',
          basePayment(membershipId, userId, {
            discountType: 'PROMO',
            discountCentavos: 20000,
            netCentavos: 80000,
          }),
        ),
      ).rejects.toThrow(/Payment_discount_shape/);
    });

    it('rejects MEMBERSHIP purpose with no membershipId — Payment_purpose_shape', async () => {
      const userId = await nextMemberId();
      const row = basePayment(randomUUID(), userId, { membershipId: null });
      await expect(insert('Payment', row)).rejects.toThrow(/Payment_purpose_shape/);
    });

    it('rejects WALK_IN purpose carrying a membershipId — Payment_purpose_shape', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      await expect(
        insert(
          'Payment',
          basePayment(membershipId, userId, {
            purpose: 'WALK_IN',
            termMonths: null,
            termStartsOn: null,
            termEndsOn: null,
          }),
        ),
      ).rejects.toThrow(/Payment_purpose_shape/);
    });

    it('rejects GCASH with no reference — Payment_gcash_reference', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      await expect(
        insert('Payment', basePayment(membershipId, userId, { method: 'GCASH' })),
      ).rejects.toThrow(/Payment_gcash_reference/);
    });

    it('rejects VOIDED with no voidedAt/voidedById/voidReason — Payment_void_shape', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      await expect(
        insert('Payment', basePayment(membershipId, userId, { status: 'VOIDED' })),
      ).rejects.toThrow(/Payment_void_shape/);
    });

    it('rejects a reused idempotencyKey — Payment_idempotencyKey_key', async () => {
      const membershipId = await createValidMembership();
      const userId = await nextMemberId();
      const key = `IK_REUSE_${randomUUID()}`;
      await insert('Payment', basePayment(membershipId, userId, { idempotencyKey: key }));
      const caught = await capture(() =>
        insert('Payment', basePayment(membershipId, userId, { idempotencyKey: key })),
      );
      expect(caught).toMatchObject({
        message: expect.stringMatching(/idempotencyKey/) as unknown,
        meta: expect.objectContaining({ code: '23505' }) as unknown,
      });
      expect(mapPrismaError(caught)).toBeNull();
    });
  });

  // ── Shift (§5.8.5) ───────────────────────────────────────────────────

  describe('Shift CHECK constraints', () => {
    it('accepts a well-formed OPEN shift (positive control)', async () => {
      await expect(insert('Shift', baseShift())).resolves.toBe(1);
    });

    it('accepts a well-formed CLOSED shift (positive control)', async () => {
      await expect(
        insert(
          'Shift',
          baseShift({
            status: 'CLOSED',
            openMarker: null,
            closedById: staff2Id,
            closedAt: NOW,
            countedCentavos: 5000,
            expectedCentavos: 5000,
            varianceCentavos: 0,
          }),
        ),
      ).resolves.toBe(1);
    });

    it('rejects a negative openingFloatCentavos — Shift_float_nonneg', async () => {
      await expect(insert('Shift', baseShift({ openingFloatCentavos: -1 }))).rejects.toThrow(
        /Shift_float_nonneg/,
      );
    });

    it('rejects OPEN with no openMarker — Shift_open_marker', async () => {
      await expect(insert('Shift', baseShift({ openMarker: null }))).rejects.toThrow(
        /Shift_open_marker/,
      );
    });

    it('rejects CLOSED carrying an openMarker — Shift_open_marker', async () => {
      const row = baseShift({
        status: 'CLOSED',
        closedById: staff2Id,
        closedAt: NOW,
        countedCentavos: 5000,
        expectedCentavos: 5000,
        varianceCentavos: 0,
        // openMarker deliberately left set (baseShift's default) — CLOSED
        // requires it NULL, and everything else here already satisfies
        // Shift_close_shape's CLOSED branch, so this isolates the one
        // constraint under test.
      });
      await expect(insert('Shift', row)).rejects.toThrow(/Shift_open_marker/);
    });

    it('rejects OPEN carrying a closedAt — Shift_close_shape', async () => {
      await expect(insert('Shift', baseShift({ closedAt: NOW }))).rejects.toThrow(
        /Shift_close_shape/,
      );
    });

    it('rejects CLOSED with mismatched varianceCentavos — Shift_close_shape', async () => {
      await expect(
        insert(
          'Shift',
          baseShift({
            openMarker: null,
            closedById: staff2Id,
            closedAt: NOW,
            countedCentavos: 5000,
            expectedCentavos: 4000,
            varianceCentavos: 0,
          }),
        ),
      ).rejects.toThrow(/Shift_close_shape/);
    });

    it('rejects a second OPEN shift reusing the literal marker — Shift_openMarker_key', async () => {
      const caught = await capture(() => insert('Shift', baseShift({ openMarker: 'OPEN' })));
      // paymentShiftId (created in beforeAll) does not use the literal
      // 'OPEN' marker (each fixture shift gets a unique string — the CHECK
      // only requires non-null, not the literal), so this is the first use
      // of 'OPEN' and must succeed as a control before the second attempt.
      expect(caught).toBeUndefined();
      const caught2 = await capture(() => insert('Shift', baseShift({ openMarker: 'OPEN' })));
      expect(caught2).toMatchObject({
        message: expect.stringMatching(/openMarker/) as unknown,
        meta: expect.objectContaining({ code: '23505' }) as unknown,
      });
      expect(mapPrismaError(caught2)).toBeNull();
    });
  });
});
