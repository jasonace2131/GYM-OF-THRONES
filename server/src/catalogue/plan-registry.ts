import { PlanKind, type PrismaClient } from '@prisma/client';

/**
 * The published price list, as data.
 *
 * Mirrors the shape of `rbac/permission-registry.ts` — a frozen catalogue plus
 * an assertion plus a seed pass — with one deliberate difference that matters
 * more than the similarity: **this seed is CREATE-ONLY**. The permission
 * catalogue is convergent because permissions are code; prices are business
 * data owned by whoever runs the gym, and a convergent seed re-run on deploy
 * would quietly revert every price change they made.
 *
 * §5.0 decision: the walk-in price lives HERE, in a Plan row with
 * kind = WALK_IN, so no client hardcodes ₱90 and chunk 2's walk-in sale
 * snapshots from the same row every other sale snapshots from.
 *
 * `PlanKind` is imported from `@prisma/client` rather than `@got/shared`
 * on purpose: this module is on `prisma/seed.ts`'s import path, and the seed
 * runs through ts-node with no `@got/shared` build step in front of it. The
 * two enums are proved identical by `enum-parity.spec.ts` (task 1), so nothing
 * is lost by naming the Prisma one here.
 */

export interface PlanDefinition {
  /** Stable machine identifier, snapshotted onto Membership and Payment. */
  code: string;
  name: string;
  description: string;
  kind: PlanKind;
  /** Centavos of PHP. One gym, one location, one currency, so no currency column. */
  priceCentavos: number;
  /** NULL exactly when kind = WALK_IN. 1..60 otherwise. */
  termMonths: number | null;
  freezable: boolean;
  guestPassesPerTerm: number;
  graceDays: number;
  /** Bullet points for the pricing grid. Billing-adjacent copy only. */
  perks: string[];
  sortOrder: number;
}

export const PLAN_REGISTRY: readonly PlanDefinition[] = [
  {
    code: 'WALKIN',
    name: 'Walk-in',
    description: 'One day of access, paid at the counter.',
    kind: PlanKind.WALK_IN,
    priceCentavos: 9000,
    termMonths: null,
    // A single day cannot be paused and has no term to extend.
    freezable: false,
    guestPassesPerTerm: 0,
    graceDays: 0,
    perks: ['Full access for one day', 'No sign-up, no commitment'],
    sortOrder: 0,
  },
  {
    code: 'MONTHLY',
    name: 'Monthly',
    description: 'One month from your join date, renewed on the same day each month.',
    kind: PlanKind.TERM,
    priceCentavos: 80000,
    termMonths: 1,
    // §5.6, deliberately false: a monthly member simply renews later, which
    // removes the majority of freeze requests by volume and is explainable in
    // one sentence at the counter.
    freezable: false,
    guestPassesPerTerm: 0,
    graceDays: 3,
    perks: ['Full gym access', 'Free orientation on your first visit', '3-day grace period'],
    sortOrder: 1,
  },
  {
    code: 'QUARTERLY',
    name: 'Quarterly',
    description: 'Three months at a lower monthly rate, freezable once per term.',
    kind: PlanKind.TERM,
    priceCentavos: 220000,
    termMonths: 3,
    freezable: true,
    guestPassesPerTerm: 0,
    graceDays: 3,
    perks: [
      'Full gym access',
      'Cheaper than three separate monthly terms',
      'One freeze per term, 7 to 90 days',
      '3-day grace period',
    ],
    sortOrder: 2,
  },
  {
    code: 'ANNUAL',
    name: 'Annual',
    description: 'Twelve months at the best rate, with guest passes and freezing.',
    kind: PlanKind.TERM,
    priceCentavos: 750000,
    termMonths: 12,
    freezable: true,
    guestPassesPerTerm: 2,
    graceDays: 3,
    perks: [
      'Full gym access',
      'Cheaper than twelve separate monthly terms',
      '2 guest passes per term',
      'One freeze per term, 7 to 90 days',
      '3-day grace period',
    ],
    sortOrder: 3,
  },
];

/**
 * The `Plan_term_matches_kind` CHECK, expressed once in TypeScript.
 *
 * Returns a message rather than throwing, because it has two audiences with
 * two correct reactions: the registry assertion below turns it into a boot-time
 * `Error` (a bad catalogue must never be half-applied), and `PlansService`
 * turns it into a 400. The constraint in the database is the backstop behind
 * both — a 422 from it would be a bug report, not a user path.
 */
export function planShapeError(
  kind: PlanKind,
  termMonths: number | null | undefined,
  freezable: boolean,
): string | null {
  if (kind === PlanKind.TERM) {
    if (termMonths === null || termMonths === undefined) {
      return 'A TERM plan must carry termMonths.';
    }
    if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 60) {
      return 'termMonths must be a whole number between 1 and 60.';
    }
    return null;
  }

  if (termMonths !== null && termMonths !== undefined) {
    return 'A WALK_IN plan prices a single day and takes no termMonths.';
  }
  if (freezable) {
    return 'A WALK_IN plan cannot be frozen — there is no term to extend.';
  }
  return null;
}

/** Bounds written to match §5.8.2's four Plan CHECKs exactly. */
export function assertPlanRegistryValid(registry: readonly PlanDefinition[]): void {
  const seen = new Set<string>();

  for (const plan of registry) {
    if (seen.has(plan.code)) {
      throw new Error(`Plan registry has a duplicate plan code ${plan.code}`);
    }
    seen.add(plan.code);

    const shape = planShapeError(plan.kind, plan.termMonths, plan.freezable);
    if (shape) throw new Error(`Plan ${plan.code}: ${shape}`);

    if (!Number.isInteger(plan.priceCentavos) || plan.priceCentavos < 0) {
      throw new Error(`Plan ${plan.code}: priceCentavos must be a non-negative integer`);
    }
    if (plan.priceCentavos > 10_000_000) {
      throw new Error(`Plan ${plan.code}: priceCentavos exceeds the ₱100,000 ceiling`);
    }
    if (plan.graceDays < 0 || plan.graceDays > 14) {
      throw new Error(`Plan ${plan.code}: graceDays must be between 0 and 14`);
    }
    if (plan.guestPassesPerTerm < 0 || plan.guestPassesPerTerm > 12) {
      throw new Error(`Plan ${plan.code}: guestPassesPerTerm must be between 0 and 12`);
    }
  }
}

/**
 * Creates any plan whose `code` is not already present, and touches nothing
 * else. `createMany({ skipDuplicates: true })` compiles to
 * INSERT … ON CONFLICT DO NOTHING, so a re-seed is one statement that reports
 * how many rows it declined to write and leaves every hand-edited price alone.
 */
export async function seedPlans(
  prisma: PrismaClient,
  registry: readonly PlanDefinition[] = PLAN_REGISTRY,
): Promise<{ created: number; skipped: number }> {
  assertPlanRegistryValid(registry);

  const { count } = await prisma.plan.createMany({
    data: registry.map((plan) => ({
      code: plan.code,
      name: plan.name,
      description: plan.description,
      kind: plan.kind,
      priceCentavos: plan.priceCentavos,
      termMonths: plan.termMonths,
      freezable: plan.freezable,
      guestPassesPerTerm: plan.guestPassesPerTerm,
      graceDays: plan.graceDays,
      perks: plan.perks,
      sortOrder: plan.sortOrder,
    })),
    skipDuplicates: true,
  });

  return { created: count, skipped: registry.length - count };
}
