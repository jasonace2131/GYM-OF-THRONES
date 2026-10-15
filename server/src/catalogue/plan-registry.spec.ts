import { PlanKind, type PrismaClient } from '@prisma/client';
import {
  PLAN_REGISTRY,
  assertPlanRegistryValid,
  planShapeError,
  seedPlans,
  type PlanDefinition,
} from './plan-registry';

interface PrismaStub {
  plan: { createMany: jest.Mock };
}

function buildPrisma(count: number): PrismaStub {
  return { plan: { createMany: jest.fn().mockResolvedValue({ count }) } };
}

function byCode(code: string): PlanDefinition {
  const found = PLAN_REGISTRY.find((plan) => plan.code === code);
  if (!found) throw new Error(`PLAN_REGISTRY has no ${code}`);
  return found;
}

describe('PLAN_REGISTRY', () => {
  it('publishes exactly the four §5.3.2 plans, in sort order', () => {
    expect(PLAN_REGISTRY.map((plan) => plan.code)).toEqual([
      'WALKIN',
      'MONTHLY',
      'QUARTERLY',
      'ANNUAL',
    ]);
    expect(PLAN_REGISTRY.map((plan) => plan.sortOrder)).toEqual([0, 1, 2, 3]);
  });

  it('carries the confirmed prices as integer centavos', () => {
    expect(byCode('WALKIN').priceCentavos).toBe(9000);
    expect(byCode('MONTHLY').priceCentavos).toBe(80000);
    expect(byCode('QUARTERLY').priceCentavos).toBe(220000);
    expect(byCode('ANNUAL').priceCentavos).toBe(750000);
  });

  it('puts the walk-in price in a Plan row so no client hardcodes ₱90', () => {
    const walkIn = byCode('WALKIN');
    expect(walkIn.kind).toBe(PlanKind.WALK_IN);
    expect(walkIn.termMonths).toBeNull();
    expect(walkIn.freezable).toBe(false);
    expect(walkIn.graceDays).toBe(0);
  });

  // §5.6: the load-bearing entitlement. A monthly member simply renews later,
  // which removes the majority of freeze requests by volume.
  it('makes MONTHLY unfreezable and the two longer terms freezable', () => {
    expect(byCode('MONTHLY').freezable).toBe(false);
    expect(byCode('QUARTERLY').freezable).toBe(true);
    expect(byCode('ANNUAL').freezable).toBe(true);
  });

  it('gives every term plan three grace days and only ANNUAL its guest passes', () => {
    expect(byCode('MONTHLY').graceDays).toBe(3);
    expect(byCode('QUARTERLY').graceDays).toBe(3);
    expect(byCode('ANNUAL').graceDays).toBe(3);
    expect(byCode('MONTHLY').guestPassesPerTerm).toBe(0);
    expect(byCode('QUARTERLY').guestPassesPerTerm).toBe(0);
    expect(byCode('ANNUAL').guestPassesPerTerm).toBe(2);
  });

  it('validates clean', () => {
    expect(() => assertPlanRegistryValid(PLAN_REGISTRY)).not.toThrow();
  });

  it('rejects a duplicate code — the code is the snapshot key and never reused', () => {
    expect(() => assertPlanRegistryValid([byCode('MONTHLY'), byCode('MONTHLY')])).toThrow(
      /duplicate plan code MONTHLY/,
    );
  });
});

describe('planShapeError', () => {
  it('accepts the two legal shapes', () => {
    expect(planShapeError(PlanKind.TERM, 3, true)).toBeNull();
    expect(planShapeError(PlanKind.WALK_IN, null, false)).toBeNull();
  });

  it('refuses a TERM plan with no termMonths', () => {
    expect(planShapeError(PlanKind.TERM, null, false)).toMatch(/termMonths/);
    expect(planShapeError(PlanKind.TERM, undefined, false)).toMatch(/termMonths/);
  });

  it('refuses a TERM plan outside 1..60 months', () => {
    expect(planShapeError(PlanKind.TERM, 0, false)).toMatch(/1 and 60/);
    expect(planShapeError(PlanKind.TERM, 61, false)).toMatch(/1 and 60/);
  });

  it('refuses a WALK_IN plan that carries a term or claims to be freezable', () => {
    expect(planShapeError(PlanKind.WALK_IN, 1, false)).toMatch(/no termMonths/);
    expect(planShapeError(PlanKind.WALK_IN, null, true)).toMatch(/cannot be frozen/);
  });
});

describe('seedPlans', () => {
  it('is CREATE-ONLY: one createMany with skipDuplicates, never an upsert', async () => {
    const prisma = buildPrisma(4);

    const result = await seedPlans(prisma as unknown as PrismaClient);

    expect(prisma.plan.createMany).toHaveBeenCalledTimes(1);
    const args = prisma.plan.createMany.mock.calls[0][0] as {
      data: unknown[];
      skipDuplicates: boolean;
    };
    expect(args.skipDuplicates).toBe(true);
    expect(args.data).toHaveLength(4);
    expect(result).toEqual({ created: 4, skipped: 0 });
  });

  it('reports every row skipped on a re-seed, so a price edit is never reverted', async () => {
    const prisma = buildPrisma(0);

    expect(await seedPlans(prisma as unknown as PrismaClient)).toEqual({ created: 0, skipped: 4 });
  });

  it('validates the registry BEFORE writing anything', async () => {
    const prisma = buildPrisma(4);
    const broken: PlanDefinition[] = [{ ...byCode('MONTHLY'), termMonths: null }];

    await expect(seedPlans(prisma as unknown as PrismaClient, broken)).rejects.toThrow(
      /termMonths/,
    );
    expect(prisma.plan.createMany).not.toHaveBeenCalled();
  });
});
