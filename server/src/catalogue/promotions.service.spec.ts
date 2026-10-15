import { PromotionsService } from './promotions.service';
import type { PrismaService } from '../prisma/prisma.service';
import { DomainException } from '../common/exceptions/domain.exception';
import type { CivilDate } from '../common/time/gym-time';

const TODAY = '2026-09-15' as CivilDate;
const MONTHLY = { code: 'MONTHLY', kind: 'TERM', priceCentavos: 80_000 };

/** A live, unlimited 20% promo on every term plan. */
const base = {
  id: 'p1',
  code: 'SUMMER20',
  label: 'Summer sale',
  kind: 'PERCENTAGE' as const,
  value: 2000,
  startsOn: new Date('2026-09-01T00:00:00.000Z'),
  endsOn: new Date('2026-09-30T00:00:00.000Z'),
  maxRedemptions: null as number | null,
  redeemedCount: 0,
  planCodes: [] as string[],
  isActive: true,
  createdById: 'u1',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('PromotionsService.quote', () => {
  const findUnique = jest.fn();
  const prisma = { promotion: { findUnique } } as unknown as PrismaService;
  const service = new PromotionsService(prisma);

  beforeEach(() => findUnique.mockReset());

  const expectRejection = async (code: string): Promise<DomainException> => {
    try {
      await service.quote('SUMMER20', MONTHLY, TODAY);
    } catch (caught) {
      expect((caught as DomainException).code).toBe(code);
      return caught as DomainException;
    }
    throw new Error(`expected ${code}`);
  };

  it('prices a percentage promo in basis points', async () => {
    findUnique.mockResolvedValue(base);

    const quote = await service.quote('SUMMER20', MONTHLY, TODAY);

    // 2000 bp of ₱800 = ₱160.
    expect(quote.discountCentavos).toBe(16_000);
    expect(quote.reason).toBe('PROMO SUMMER20 — Summer sale');
  });

  it('prices a fixed promo in centavos', async () => {
    findUnique.mockResolvedValue({ ...base, kind: 'FIXED', value: 50_000 });

    const quote = await service.quote('SUMMER20', MONTHLY, TODAY);

    expect(quote.discountCentavos).toBe(50_000);
  });

  /**
   * `Payment_money_consistent` requires `discountCentavos <= vatBaseCentavos`.
   * Without the clamp a ₱1,000 fixed promo on an ₱800 plan is not a free
   * membership — it is a row the database refuses, surfacing at the counter
   * as an unexplained failure mid-sale.
   */
  it('never discounts more than the price', async () => {
    findUnique.mockResolvedValue({ ...base, kind: 'FIXED', value: 100_000 });

    const quote = await service.quote('SUMMER20', MONTHLY, TODAY);

    expect(quote.discountCentavos).toBe(80_000);
  });

  it('is case-insensitive about the code a member says out loud', async () => {
    findUnique.mockResolvedValue(base);

    await service.quote('summer20', MONTHLY, TODAY);

    expect(findUnique).toHaveBeenCalledWith({ where: { code: 'SUMMER20' } });
  });

  it.each<[string, Partial<typeof base>, string]>([
    ['before it starts', { startsOn: new Date('2026-10-01T00:00:00.000Z') }, 'PROMOTION_NOT_STARTED'],
    ['after it ends', { endsOn: new Date('2026-09-01T00:00:00.000Z') }, 'PROMOTION_EXPIRED'],
    ['archived', { isActive: false }, 'PROMOTION_NOT_FOUND'],
    ['fully redeemed', { maxRedemptions: 5, redeemedCount: 5 }, 'PROMOTION_EXHAUSTED'],
    ['scoped to another plan', { planCodes: ['ANNUAL'] }, 'PROMOTION_NOT_APPLICABLE'],
  ])('refuses one that is %s', async (_label, patch, code) => {
    findUnique.mockResolvedValue({ ...base, ...patch });
    await expectRejection(code);
  });

  it('refuses a code nobody created', async () => {
    findUnique.mockResolvedValue(null);
    await expectRejection('PROMOTION_NOT_FOUND');
  });

  /**
   * THE OWNER'S DECISION, ENFORCED IN THE SERVICE.
   *
   * A ₱90 day pass discounted by a promo is worth less than the
   * reconciliation noise it puts in the drawer, and a walk-in is a stranger
   * the gym has no relationship to reward. Keeping it here rather than in a
   * sale screen means the next screen someone writes inherits the rule.
   */
  it('refuses a walk-in day pass — promos are members only', async () => {
    findUnique.mockResolvedValue(base);

    await expect(
      service.quote('SUMMER20', { code: 'WALKIN', kind: 'WALK_IN', priceCentavos: 9_000 }, TODAY),
    ).rejects.toMatchObject({ code: 'PROMOTION_NOT_APPLICABLE' });
  });

  it('accepts a plan it explicitly names', async () => {
    findUnique.mockResolvedValue({ ...base, planCodes: ['MONTHLY', 'QUARTERLY'] });

    await expect(service.quote('SUMMER20', MONTHLY, TODAY)).resolves.toMatchObject({
      code: 'SUMMER20',
    });
  });

  it('allows the last redemption of a capped promo', async () => {
    findUnique.mockResolvedValue({ ...base, maxRedemptions: 5, redeemedCount: 4 });

    await expect(service.quote('SUMMER20', MONTHLY, TODAY)).resolves.toMatchObject({
      discountCentavos: 16_000,
    });
  });
});

describe('PromotionsService.redeem', () => {
  it('spends a redemption with a CONDITIONAL update, not read-then-write', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findUnique = jest.fn().mockResolvedValue({ maxRedemptions: 10 });
    const tx = { promotion: { updateMany, findUnique } };
    const service = new PromotionsService({} as unknown as PrismaService);

    await service.redeem(tx as never, 'SUMMER20');

    const [args] = updateMany.mock.calls[0] as [{ data: unknown; where: unknown }];
    expect(args.data).toEqual({ redeemedCount: { increment: 1 } });
    // The cap travels in the WHERE. Two staff ringing the last redemption at
    // once would both read `9` and both proceed if this were a read-then-write.
    expect(JSON.stringify(args.where)).toContain('redeemedCount');
  });

  it('reports a conflict when the last redemption went to somebody else', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const findUnique = jest.fn().mockResolvedValue({ maxRedemptions: 10 });
    const tx = { promotion: { updateMany, findUnique } };
    const service = new PromotionsService({} as unknown as PrismaService);

    await expect(service.redeem(tx as never, 'SUMMER20')).rejects.toMatchObject({
      code: 'PROMOTION_EXHAUSTED',
    });
  });
});
