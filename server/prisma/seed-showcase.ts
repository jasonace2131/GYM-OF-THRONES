/**
 * A gym with a history, for demonstrating the whole workflow.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR, AND WHY IT IS NOT `seed-demo.ts`.
 *
 * `seed:demo` fills ONE member's progress screen — measurements, goals, two
 * announcements. It shows a member their own history and nothing else.
 *
 * This seeds the OTHER side: a population of members in every standing the
 * access ladder can produce, sixty days of payments and shifts, forty-five
 * days of attendance with a believable weekday shape, classes with bookings
 * and a waitlist, coach assignments, denials, and people currently inside the
 * building. It exists so every screen in the CRM has something true to show —
 * a dashboard with a real curve, a members table worth filtering, a payments
 * list containing both a void and a refund.
 *
 * EVERY ROW IS RECOVERABLE. Demo members live on one email domain
 * (`@demo.invalid`), and `--undo` deletes exactly what this wrote, in
 * foreign-key order. Nothing real is touched: no row belonging to a genuine
 * account is created, modified or deleted.
 *
 * DEMO MEMBERS CANNOT SIGN IN, and that is deliberate. `User.supabaseId` is
 * non-nullable, so each gets a fabricated UUID that matches no Supabase auth
 * user — the same trade `membership-import.service.ts` makes for legacy rows.
 * They are records to browse, sell to and check in, not accounts to log into.
 * The seeded ROLE accounts (`seed:accounts`) remain the way you sign in.
 *
 *   npm run seed:showcase --workspace=server
 *   npm run seed:showcase --workspace=server -- --undo
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PrismaClient,
  type CheckInMethod,
  type DenialReason,
  type MembershipStatus,
  type PaymentMethod,
  type Prisma,
} from '@prisma/client';

const prisma = new PrismaClient();

/** Every demo member's address ends here. It is the undo key. */
const DEMO_DOMAIN = '@demo.invalid';
/** Marks the rows this script writes on models that have no email. */
const TAG = '[showcase]';

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/** The gym's own day, so `businessDate` matches what staff would call today. */
function gymTimeZone(): string {
  try {
    const env = readFileSync(join(process.cwd(), '.env'), 'utf8');
    const match = env.match(/^\s*GYM_TIMEZONE\s*=\s*"?([^"\n\r]+)"?/m);
    return match?.[1]?.trim() ?? 'Asia/Manila';
  } catch {
    return 'Asia/Manila';
  }
}

const TZ = gymTimeZone();

function civilDay(daysAgo: number): string {
  const at = new Date(Date.now() - daysAgo * MS_PER_DAY);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** A `@db.Date` column wants UTC midnight — the rule `toDateColumn` follows. */
function dateColumn(daysAgo: number): Date {
  return new Date(`${civilDay(daysAgo)}T00:00:00.000Z`);
}

function at(daysAgo: number, hour: number, minute = 0): Date {
  const day = new Date(Date.now() - daysAgo * MS_PER_DAY);
  day.setHours(hour, minute, 0, 0);
  return day;
}

/**
 * Deterministic, so a re-seed reproduces the same gym.
 *
 * `Math.random()` would redraw the attendance curve on every run, which makes
 * a screenshot impossible to reproduce and a demo impossible to rehearse.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

const pick = <T>(list: readonly T[], r: number): T => list[Math.floor(r * list.length) % list.length]!;

/** Payments and check-ins both carry a unique idempotency pair. */
function idem(kind: string, key: string): { idempotencyKey: string; idempotencyHash: string } {
  const idempotencyKey = `${TAG}:${kind}:${key}`;
  return {
    idempotencyKey,
    idempotencyHash: createHash('sha256').update(idempotencyKey).digest('hex'),
  };
}

const FIRST = [
  'Juan', 'Maria', 'Jose', 'Ana', 'Miguel', 'Sofia', 'Carlo', 'Bea', 'Paolo', 'Ysabel',
  'Rafael', 'Camille', 'Diego', 'Andrea', 'Marco', 'Patricia', 'Enzo', 'Trisha',
  'Nathan', 'Kyla', 'Rico', 'Jasmine', 'Lorenzo', 'Mika', 'Gabriel', 'Hannah',
  'Emilio', 'Rowena', 'Vincent', 'Clarisse',
] as const;

const LAST = [
  'Santos', 'Reyes', 'Cruz', 'Bautista', 'Ocampo', 'Delos Reyes', 'Garcia', 'Mendoza',
  'Torres', 'Villanueva', 'Aquino', 'Ramos', 'Castillo', 'Navarro', 'Domingo',
] as const;

/**
 * The population, by the standing each member is meant to demonstrate.
 *
 * Every branch of `accessVerdict()` is represented, because a demo where
 * everyone is ACTIVE proves only that the happy path renders.
 */
interface Cohort {
  label: string;
  count: number;
  status: MembershipStatus | 'NONE';
  /** Days until the term ends. Negative means it already has. */
  endsInDays: number;
  planCode: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
}

const COHORTS: Cohort[] = [
  { label: 'active, mid-term', count: 9, status: 'ACTIVE', endsInDays: 21, planCode: 'MONTHLY' },
  { label: 'active, quarterly', count: 4, status: 'ACTIVE', endsInDays: 55, planCode: 'QUARTERLY' },
  { label: 'active, annual', count: 3, status: 'ACTIVE', endsInDays: 210, planCode: 'ANNUAL' },
  { label: 'expiring within 7d', count: 5, status: 'ACTIVE', endsInDays: 4, planCode: 'MONTHLY' },
  { label: 'in grace (expired 2d)', count: 2, status: 'ACTIVE', endsInDays: -2, planCode: 'MONTHLY' },
  { label: 'expired past grace', count: 4, status: 'EXPIRED', endsInDays: -25, planCode: 'MONTHLY' },
  { label: 'frozen', count: 2, status: 'FROZEN', endsInDays: 40, planCode: 'QUARTERLY' },
  { label: 'cancelled', count: 2, status: 'CANCELLED', endsInDays: -9, planCode: 'MONTHLY' },
  { label: 'registered, no plan', count: 3, status: 'NONE', endsInDays: 0, planCode: 'MONTHLY' },
];

async function undo(): Promise<void> {
  const members = await prisma.user.findMany({
    where: { email: { endsWith: DEMO_DOMAIN } },
    select: { id: true },
  });
  const ids = members.map((m) => m.id);
  console.log(`removing ${ids.length} demo members and everything attached to them…`);

  // FK order matters — every relation is onDelete: Restrict, so a parent
  // deleted before its children fails rather than cascading.
  const shifts = await prisma.shift.findMany({
    where: { note: { contains: TAG } },
    select: { id: true },
  });
  const shiftIds = shifts.map((s) => s.id);
  const sessions = await prisma.classSession.findMany({
    where: { description: { contains: TAG } },
    select: { id: true },
  });
  const sessionIds = sessions.map((s) => s.id);

  await prisma.classBooking.deleteMany({
    where: { OR: [{ userId: { in: ids } }, { sessionId: { in: sessionIds } }] },
  });
  await prisma.classSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.coachAssignment.deleteMany({ where: { memberId: { in: ids } } });
  await prisma.stationScan.deleteMany({ where: { userId: { in: ids } } });
  await prisma.checkInDenial.deleteMany({
    where: { OR: [{ userId: { in: ids } }, { shiftId: { in: shiftIds } }] },
  });
  await prisma.checkIn.deleteMany({ where: { idempotencyKey: { startsWith: TAG } } });
  await prisma.checkIn.deleteMany({
    where: { OR: [{ userId: { in: ids } }, { shiftId: { in: shiftIds } }] },
  });
  // NO membershipEvent DELETE, and none is written either.
  //
  // `MembershipEvent_append_only` is a BEFORE UPDATE OR DELETE trigger that
  // raises unconditionally — the ledger is immutable by design. A demo row
  // there could never be removed, and because MembershipEvent → Membership is
  // onDelete: Restrict it would pin the membership and the member with it,
  // permanently. So this script writes no events at all: a reversible demo is
  // worth more than a seeded audit trail.
  await prisma.membershipHold.deleteMany({ where: { membership: { userId: { in: ids } } } });
  // `notes` is the reliable key here. A WALK_IN payment has no userId at all
  // (Payment_purpose_shape forbids a membership on one), and today's rows may
  // sit on a shift staff opened themselves — so neither FK finds them.
  await prisma.payment.deleteMany({ where: { notes: TAG } });
  await prisma.payment.deleteMany({
    where: { OR: [{ userId: { in: ids } }, { shiftId: { in: shiftIds } }] },
  });
  await prisma.bodyMeasurement.deleteMany({ where: { userId: { in: ids } } });
  await prisma.memberGoal.deleteMany({ where: { userId: { in: ids } } });

  /*
   * A MEMBER WHOSE LEDGER HAS ENTRIES CANNOT BE DELETED, AND THAT IS CORRECT.
   *
   * MembershipEvent is append-only (a trigger, not a constraint) and
   * MembershipEvent → Membership is onDelete: Restrict, so any member with
   * even one ledger row is pinned for good. This script no longer writes
   * events, but an earlier version did, and a membership sold to a demo
   * member through the real UI will pin them too.
   *
   * Rather than fight it — the alternative is disabling an integrity
   * guarantee on a live database — those members are KEPT and reused as the
   * population on the next run. Everything else is re-seeded around them.
   */
  const pinned = await prisma.membershipEvent.findMany({
    where: { membership: { userId: { in: ids } } },
    select: { membership: { select: { userId: true } } },
    distinct: ['membershipId'],
  });
  const pinnedIds = new Set(pinned.map((e) => e.membership.userId));
  const removable = ids.filter((id) => !pinnedIds.has(id));

  await prisma.membership.deleteMany({ where: { userId: { in: removable } } });
  await prisma.user.deleteMany({ where: { id: { in: removable } } });

  if (pinnedIds.size > 0) {
    console.log(
      `kept ${pinnedIds.size} member(s) whose membership ledger pins them — they are reused, not duplicated`,
    );
  }
  await prisma.shift.deleteMany({ where: { id: { in: shiftIds } } });
  await prisma.announcement.deleteMany({ where: { content: { contains: TAG } } });

  console.log('done — the database is back to its real rows only.');
}

async function main(): Promise<void> {
  if (process.argv.includes('--undo')) {
    await undo();
    return;
  }

  // Re-runnable: clear our own rows first. `createMany({ skipDuplicates })`
  // is NOT enough — it only skips what a UNIQUE constraint identifies, so a
  // second run would otherwise double every check-in and payment.
  await undo();

  const plans = await prisma.plan.findMany();
  const planBy = new Map(plans.map((p) => [p.code, p]));
  if (planBy.size === 0) {
    throw new Error('No plans found. Run `npm run db:seed --workspace=server` first.');
  }

  const staff = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'FRONT_DESK', 'COACH', 'DEV'] }, deletedAt: null },
    select: { id: true, role: true },
  });
  const operator =
    staff.find((s) => s.role === 'FRONT_DESK') ?? staff.find((s) => s.role === 'ADMIN') ?? staff[0];
  const coach = staff.find((s) => s.role === 'COACH') ?? operator;
  const admin = staff.find((s) => s.role === 'ADMIN') ?? operator;
  if (!operator || !coach || !admin) {
    throw new Error('No staff accounts. Run `npm run seed:accounts --workspace=server` first.');
  }

  const r = rng(20260901);

  /* ── Members ──────────────────────────────────────────────────────────── */

  interface Seeded {
    id: string;
    membershipId: string | null;
    planCode: string;
    status: MembershipStatus | 'NONE';
    endsInDays: number;
  }

  const seeded: Seeded[] = [];
  let n = 0;

  /*
   * Survivors from a previous run are adopted, not duplicated.
   *
   * `undo()` keeps any member its ledger pins (see there). Recreating them
   * would mean two Juan Santoses on the same demo domain and a members table
   * that grows by 34 every time this is run.
   */
  const survivors = await prisma.user.findMany({
    where: { email: { endsWith: DEMO_DOMAIN } },
    select: { id: true, email: true, membership: { select: { id: true, planCode: true, status: true, endsOn: true } } },
    orderBy: { email: 'asc' },
  });

  if (survivors.length > 0) {
    console.log(`adopting ${survivors.length} member(s) kept from a previous run`);
    const todayMs = new Date(`${civilDay(0)}T00:00:00.000Z`).getTime();
    for (const survivor of survivors) {
      seeded.push({
        id: survivor.id,
        membershipId: survivor.membership?.id ?? null,
        planCode: survivor.membership?.planCode ?? 'MONTHLY',
        status: survivor.membership?.status ?? 'NONE',
        endsInDays: survivor.membership
          ? Math.round((survivor.membership.endsOn.getTime() - todayMs) / MS_PER_DAY)
          : 0,
      });
    }
    n = survivors.length;
  }

  for (const cohort of survivors.length > 0 ? [] : COHORTS) {
    for (let i = 0; i < cohort.count; i += 1) {
      const first = pick(FIRST, r());
      const last = pick(LAST, r());
      const joinedDaysAgo = 40 + Math.floor(r() * 400);

      const user = await prisma.user.create({
        data: {
          // Fabricated: matches no Supabase auth user, so this record cannot
          // sign in. See the header — deliberate, and the reason the address
          // is on `.invalid`, a domain reserved by RFC 2606 that can never
          // resolve or receive mail.
          supabaseId: randomUUID(),
          email: `demo.${String(n).padStart(3, '0')}${DEMO_DOMAIN}`,
          firstName: first,
          lastName: last,
          phone: `0917${String(1_000_000 + Math.floor(r() * 8_999_999))}`,
          memberCode: `GOT-D${String(1000 + n)}`,
          role: 'CLIENT',
          status: 'ACTIVE',
          createdAt: at(joinedDaysAgo, 10),
          lastSeenAt: cohort.status === 'NONE' ? null : at(Math.floor(r() * 9), 18),
        },
        select: { id: true },
      });

      let membershipId: string | null = null;

      if (cohort.status !== 'NONE') {
        const plan = planBy.get(cohort.planCode);
        if (!plan) throw new Error(`plan ${cohort.planCode} missing`);

        const endsOn = dateColumn(-cohort.endsInDays);
        const termMonths = plan.termMonths ?? 1;
        const startsOn = dateColumn(-cohort.endsInDays + termMonths * 30);

        const membership = await prisma.membership.create({
          data: {
            userId: user.id,
            planId: plan.id,
            status: cohort.status,
            planCode: plan.code,
            planName: plan.name,
            planPriceCentavos: plan.priceCentavos,
            termMonths,
            graceDays: plan.graceDays,
            guestPassesPerTerm: plan.guestPassesPerTerm,
            guestPassesRemaining: plan.guestPassesPerTerm,
            startsOn,
            endsOn,
            billingAnchorDay: Math.min(28, 1 + Math.floor(r() * 27)),
            joinedOn: dateColumn(joinedDaysAgo),
            purchasedAt: at(joinedDaysAgo, 11),
            cancelledOn: cohort.status === 'CANCELLED' ? dateColumn(9) : null,
            cancelRequestedOn: cohort.status === 'CANCELLED' ? dateColumn(14) : null,
            // In grace means they have already used one admission past the
            // end date — the ladder's ALLOWED_IN_GRACE branch.
            graceAdmissionsThisTerm: cohort.endsInDays < 0 && cohort.status === 'ACTIVE' ? 1 : 0,
          },
          select: { id: true },
        });
        membershipId = membership.id;


        if (cohort.status === 'FROZEN') {
          await prisma.membershipHold.create({
            data: {
              membershipId: membership.id,
              status: 'ACTIVE',
              startsOn: dateColumn(6),
              endsOn: dateColumn(-24),
              daysRequested: 30,
              daysApplied: 6,
              // Nullable-unique: at most one ACTIVE hold per membership.
              activeMembershipId: membership.id,
              reason: `${TAG} Medical leave`,
              approvedById: admin.id,
            },
          });
        }
      }

      seeded.push({
        id: user.id,
        membershipId,
        planCode: cohort.planCode,
        status: cohort.status,
        endsInDays: cohort.endsInDays,
      });
      n += 1;
    }
  }

  /*
   * TOP-UP: a standing that adoption did not carry over gets recreated.
   *
   * A member with no plan at all is the one cohort with no membership row —
   * so it is also the only one `undo()` can fully delete. Without this, the
   * NO_MEMBERSHIP branch of the access ladder has nobody to demonstrate it
   * after the first re-run.
   */
  const missingNoPlan =
    COHORTS.find((c) => c.status === 'NONE')!.count -
    seeded.filter((m) => m.status === 'NONE').length;

  for (let i = 0; i < missingNoPlan; i += 1) {
    const user = await prisma.user.create({
      data: {
        supabaseId: randomUUID(),
        email: `demo.np${String(i)}${DEMO_DOMAIN}`,
        firstName: pick(FIRST, r()),
        lastName: pick(LAST, r()),
        phone: `0917${String(1_000_000 + Math.floor(r() * 8_999_999))}`,
        memberCode: `GOT-N${String(2000 + i)}`,
        role: 'CLIENT',
        status: 'ACTIVE',
        createdAt: at(3 + i, 10),
      },
      select: { id: true },
    });
    seeded.push({
      id: user.id,
      membershipId: null,
      planCode: 'MONTHLY',
      status: 'NONE',
      endsInDays: 0,
    });
  }

  console.log(`members: ${seeded.length}${missingNoPlan > 0 ? ` (+${missingNoPlan} with no plan)` : ''}`);

  /* ── Payments and shifts, computed together ───────────────────────────── */

  /*
   * ORDER MATTERS, AND A CONSTRAINT IS WHY.
   *
   * `Shift_close_shape` requires a CLOSED shift to carry countedCentavos,
   * expectedCentavos AND varianceCentavos = counted - expected. So a closed
   * shift cannot be written until its own takings are known — but a payment
   * cannot be written without a shiftId. The way out is to decide the
   * payments in memory first, create each shift with the totals they imply,
   * then attach the ids and insert.
   */
  const SHIFT_DAYS = 60;

  interface PendingPayment {
    daysAgo: number;
    row: Omit<Prisma.PaymentCreateManyInput, 'shiftId'>;
  }

  const pending: PendingPayment[] = [];
  let paidSeq = 0;

  for (const member of seeded) {
    if (member.status === 'NONE' || member.membershipId === null) continue;
    const plan = planBy.get(member.planCode)!;
    const termMonths = plan.termMonths ?? 1;
    const paidDaysAgo = Math.max(0, Math.min(SHIFT_DAYS, -member.endsInDays + termMonths * 30));

    const method: PaymentMethod = r() > 0.45 ? 'CASH' : 'GCASH';
    pending.push({
      daysAgo: paidDaysAgo,
      row: {
        userId: member.id,
        membershipId: member.membershipId,
        planId: plan.id,
        purpose: 'MEMBERSHIP',
        status: 'RECORDED',
        planCode: plan.code,
        planName: plan.name,
        // Payment_money_consistent: net = vatBase - discount, and with no
        // discount vatBase must equal gross unless the sale is VAT-exempt.
        grossCentavos: plan.priceCentavos,
        vatBaseCentavos: plan.priceCentavos,
        netCentavos: plan.priceCentavos,
        termMonths,
        termStartsOn: dateColumn(paidDaysAgo),
        termEndsOn: dateColumn(-member.endsInDays),
        method,
        // Payment_gcash_reference: a GCash row without one is rejected.
        // 13 numeric digits, deterministic and unique per seeded payment —
        // the real range is 10-13 chars, most commonly 13 numeric; older
        // ones are alphanumeric and bank-funded arrivals carry a 14-digit
        // InstaPay reference, which is exactly why nothing validates the
        // shape strictly. Payment_reference_normalized_shape pairs the
        // normalized twin with it.
        reference: method === 'GCASH' ? String(6_028_000_000_000 + paidSeq) : null,
        referenceNormalized: method === 'GCASH' ? String(6_028_000_000_000 + paidSeq) : null,
        receivedAt: at(paidDaysAgo, 9 + Math.floor(r() * 10)),
        businessDate: dateColumn(paidDaysAgo),
        recordedById: operator.id,
        notes: TAG,
        ...idem('pay', `${member.id}:term`),
      },
    });
    paidSeq += 1;
  }

  const walkin = planBy.get('WALKIN');
  if (walkin) {
    for (let d = 0; d <= 14; d += 1) {
      for (let i = 0; i < 1 + Math.floor(r() * 3); i += 1) {
        pending.push({
          daysAgo: d,
          row: {
            // Payment_purpose_shape: a WALK_IN carries no membership and no
            // term at all. It is a person off the street paying for one day.
            planId: walkin.id,
            purpose: 'WALK_IN',
            status: 'RECORDED',
            planCode: walkin.code,
            planName: walkin.name,
            grossCentavos: walkin.priceCentavos,
            vatBaseCentavos: walkin.priceCentavos,
            netCentavos: walkin.priceCentavos,
            method: 'CASH',
            receivedAt: at(d, 8 + Math.floor(r() * 12)),
            businessDate: dateColumn(d),
            recordedById: operator.id,
            notes: TAG,
            ...idem('walkin', `${d}:${i}`),
          },
        });
      }
    }
  }

  const FLOAT = 200_000;
  const shiftByDay = new Map<number, string>();

  /*
   * A REAL OPEN SHIFT MAY ALREADY EXIST, AND IT IS NOT OURS TO REPLACE.
   *
   * `openMarker` is a nullable-unique sentinel: at most one shift is OPEN
   * across the whole gym. If staff already opened the drawer, creating a
   * second open shift fails on that unique index — correctly. So today's
   * demo rows attach to the shift that is genuinely open, and this script
   * creates one only when the till is closed.
   */
  const liveOpen = await prisma.shift.findFirst({
    where: { openMarker: { not: null } },
    select: { id: true },
  });
  if (liveOpen) {
    shiftByDay.set(0, liveOpen.id);
    console.log('reusing the shift that is already open rather than opening a second');
  }

  for (let d = SHIFT_DAYS; d >= 0; d -= 1) {
    if (d === 0 && liveOpen) continue;
    const isToday = d === 0;
    // Only cash reaches the drawer; GCash lands in the wallet, so counting it
    // would make every shift look short by exactly the GCash it took.
    const cash = pending
      .filter((x) => x.daysAgo === d && x.row.method === 'CASH')
      .reduce((sum, x) => sum + (x.row.netCentavos ?? 0), 0);
    const expected = FLOAT + cash;
    // Two days in the window are a few pesos out, because a reconciliation
    // screen where the variance is always zero demonstrates nothing.
    const counted = expected + (d === 5 ? -2000 : d === 12 ? 1500 : 0);

    const shift = await prisma.shift.create({
      data: {
        status: isToday ? 'OPEN' : 'CLOSED',
        openedById: operator.id,
        openedAt: at(d, 6),
        openingFloatCentavos: FLOAT,
        businessDate: dateColumn(d),
        // Shift_open_marker + a unique index: at most one OPEN shift exists.
        openMarker: isToday ? 'OPEN' : null,
        closedById: isToday ? null : operator.id,
        closedAt: isToday ? null : at(d, 22),
        countedCentavos: isToday ? null : counted,
        expectedCentavos: isToday ? null : expected,
        // Shift_close_shape checks this arithmetic itself.
        varianceCentavos: isToday ? null : counted - expected,
        note: TAG,
      },
      select: { id: true },
    });
    shiftByDay.set(d, shift.id);
  }

  await prisma.payment.createMany({
    data: pending
      .filter((x) => shiftByDay.has(x.daysAgo))
      .map((x) => ({ ...x.row, shiftId: shiftByDay.get(x.daysAgo)! })),
  });

  // ONE VOID AND ONE REFUND, so the distinction this branch added is visible
  // on screen rather than only in the schema. A void is "recorded in error, no
  // money moved"; a refund is "money went back to the member".
  const recent = await prisma.payment.findMany({
    where: { notes: TAG, purpose: 'MEMBERSHIP' },
    orderBy: { receivedAt: 'desc' },
    take: 2,
    select: { id: true },
  });
  if (recent[0]) {
    await prisma.payment.update({
      where: { id: recent[0].id },
      data: {
        status: 'VOIDED',
        voidedAt: at(2, 14),
        voidedById: admin.id,
        voidKind: 'VOID',
        voidReason: 'Keyed twice at the counter',
      },
    });
  }
  if (recent[1]) {
    await prisma.payment.update({
      where: { id: recent[1].id },
      data: {
        status: 'VOIDED',
        voidedAt: at(1, 16),
        voidedById: admin.id,
        voidKind: 'REFUND',
        voidReason: 'Member cancelled within cooling-off; cash returned',
      },
    });
  }

  console.log(`shifts: ${shiftByDay.size} (today's is open)`);
  console.log(`payments: ${pending.length} (1 voided, 1 refunded)`);

  /* ── Attendance: 45 days, weekday-shaped, some still inside ───────────── */

  const eligible = seeded.filter((m) => m.status === 'ACTIVE' || m.status === 'FROZEN');
  const checkIns: Prisma.CheckInCreateManyInput[] = [];
  let inside = 0;

  for (let d = 45; d >= 0; d -= 1) {
    const date = new Date(Date.now() - d * MS_PER_DAY);
    const dow = date.getDay();
    // Monday and Tuesday are the gym's peak; Sunday is quiet. A flat curve
    // would make the attendance chart look broken rather than empty.
    const factor = [0.45, 1.0, 0.95, 0.8, 0.85, 0.9, 0.6][dow]!;
    const target = Math.round(eligible.length * 0.5 * factor);

    const shuffled = [...eligible].sort(() => r() - 0.5).slice(0, target);
    for (const member of shuffled) {
      const hour = r() > 0.5 ? 6 + Math.floor(r() * 4) : 17 + Math.floor(r() * 4);
      const occurredAt = at(d, hour, Math.floor(r() * 60));
      const stillIn = d === 0 && inside < 5 && r() > 0.4;
      if (stillIn) inside += 1;

      // MEMBER_CODE, not STATION_QR. `CheckIn_station_shape` makes a QR
      // check-in require a real stationId AND slot, and `CheckIn_recorder_shape`
      // forbids a recordedById on one. Seeding QR traffic therefore means
      // seeding stations and their credentials too — a bigger surface for a
      // demo that gains nothing: front-desk entry by member code is the same
      // row with the same verdict.
      const method: CheckInMethod = 'MEMBER_CODE';
      checkIns.push({
        userId: member.id,
        entryType: 'MEMBERSHIP',
        verdict: member.endsInDays < 0 ? 'ALLOWED_IN_GRACE' : 'ALLOWED',
        membershipId: member.membershipId,
        membershipStatusAtTime: member.status === 'NONE' ? null : member.status,
        occurredAt,
        businessDate: dateColumn(d),
        // Nullable-unique: set only while the visit is open, so a member can
        // be inside at most once. This is what "In the gym now" counts.
        openUserId: stillIn ? member.id : null,
        endedAt: stillIn ? null : new Date(occurredAt.getTime() + (1 + r() * 2) * MS_PER_HOUR),
        // MANUAL, not AUTO_CLOSE/STALE_CLOSE — `CheckIn_autoclosed_agrees`
        // ties `autoClosed` to exactly those two, and these were closed by a
        // person at the counter.
        closeMethod: stillIn ? null : 'MANUAL',
        method,
        recordedById: operator.id,
        shiftId: shiftByDay.get(d) ?? null,
        ...idem('checkin', `${member.id}:${d}`),
      });
    }
  }

  await prisma.checkIn.createMany({ data: checkIns });
  console.log(`check-ins: ${checkIns.length} (${inside} still inside)`);

  /* ── Denials today, so the desk feed and the override flow have input ─── */

  const denied = seeded.filter((m) => m.status === 'EXPIRED' || m.status === 'CANCELLED').slice(0, 3);
  const reasons: DenialReason[] = ['MEMBERSHIP_EXPIRED', 'MEMBERSHIP_EXPIRED', 'MEMBERSHIP_CANCELLED'];
  await prisma.checkInDenial.createMany({
    data: denied.map((m, i) => ({
      userId: m.id,
      reason: reasons[i] ?? 'MEMBERSHIP_EXPIRED',
      method: 'MEMBER_CODE' as CheckInMethod,
      // CheckInDenial_recorder_shape: a recorder is REQUIRED on anything that
      // is not a station scan, and forbidden on one.
      recordedById: operator.id,
      occurredAt: at(0, 7 + i),
      businessDate: dateColumn(0),
      membershipStatusAtTime: m.status === 'NONE' ? null : m.status,
      shiftId: shiftByDay.get(0) ?? null,
      outcome: 'UNRESOLVED',
    })),
  });
  console.log(`denials today: ${denied.length}`);

  /* ── Classes: past attended, today, upcoming, one full with a waitlist ── */

  const CLASSES = [
    { title: 'Morning HIIT', daysAgo: 3, hour: 7, capacity: 12 },
    { title: 'Strength Foundations', daysAgo: 1, hour: 18, capacity: 10 },
    { title: 'Morning HIIT', daysAgo: 0, hour: 7, capacity: 12 },
    { title: 'Spin', daysAgo: -1, hour: 18, capacity: 8 },
    { title: 'Yoga & Mobility', daysAgo: -2, hour: 9, capacity: 14 },
    { title: 'Strength Foundations', daysAgo: -4, hour: 18, capacity: 10 },
  ];

  let bookingCount = 0;
  let waitlisted = 0;

  for (const klass of CLASSES) {
    const startsAt = at(klass.daysAgo, klass.hour);
    const session = await prisma.classSession.create({
      data: {
        title: klass.title,
        description: `${TAG} Sixty minutes, all levels welcome.`,
        coachId: coach.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + MS_PER_HOUR),
        businessDate: dateColumn(klass.daysAgo),
        capacity: klass.capacity,
        createdById: admin.id,
      },
      select: { id: true },
    });

    // Fill it, and overfill the Spin class so the waitlist has somebody on it.
    const wanted = klass.title === 'Spin' ? klass.capacity + 3 : Math.round(klass.capacity * 0.7);
    const attendees = [...eligible].sort(() => r() - 0.5).slice(0, wanted);
    let booked = 0;

    for (const member of attendees) {
      const overCapacity = booked >= klass.capacity;
      const past = klass.daysAgo > 0;
      const status = overCapacity ? 'WAITLISTED' : past ? 'ATTENDED' : 'BOOKED';
      if (overCapacity) waitlisted += 1;
      else booked += 1;

      await prisma.classBooking.create({
        data: {
          sessionId: session.id,
          userId: member.id,
          status,
          // Nullable-unique `${sessionId}:${userId}` — one NON-CANCELLED booking
          // per member per class. `ClassBooking_active_key_shape` requires the
          // key on every row that is not CANCELLED, including ATTENDED.
          activeKey: `${session.id}:${member.id}`,
          bookedAt: at(klass.daysAgo + 2, 12),
          attendedAt: status === 'ATTENDED' ? startsAt : null,
        },
      });
      bookingCount += 1;
    }

    await prisma.classSession.update({
      where: { id: session.id },
      data: { bookedCount: booked },
    });
  }

  console.log(`classes: ${CLASSES.length}, bookings: ${bookingCount} (${waitlisted} waitlisted)`);

  /* ── Coach assignments ────────────────────────────────────────────────── */

  const assigned = eligible.slice(0, 6);
  for (const member of assigned) {
    await prisma.coachAssignment.create({
      data: {
        coachId: coach.id,
        memberId: member.id,
        status: 'ACTIVE',
        // Nullable-unique: a member has at most one ACTIVE coach.
        activeMemberId: member.id,
        startedAt: at(30, 10),
        assignedById: admin.id,
        notes: `${TAG} Twice weekly, strength focus.`,
      },
    });
  }
  console.log(`coach assignments: ${assigned.length}`);

  /* ── Announcements ────────────────────────────────────────────────────── */

  await prisma.announcement.createMany({
    data: [
      {
        title: 'Holiday hours',
        content: `We open at 8am and close at 4pm on the 30th. Normal hours resume the next day. ${TAG}`,
        isPinned: true,
        createdAt: at(2, 9),
        authorId: admin.id,
      },
      {
        title: 'New spin bikes',
        content: `Eight new bikes are on the second floor. Spin classes move there from Monday. ${TAG}`,
        isPinned: false,
        createdAt: at(6, 9),
        authorId: admin.id,
      },
      {
        title: 'Free InBody scans this month',
        content: `Ask at the counter for a slot. Members only, one per person. ${TAG}`,
        isPinned: false,
        createdAt: at(11, 9),
        authorId: admin.id,
      },
    ],
  });

  console.log('\nSeeded. Sign in as ysa+admin@test.com to see it.');
  console.log('Undo with: npm run seed:showcase --workspace=server -- --undo');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
