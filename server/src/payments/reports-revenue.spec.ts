import { ReportsService } from './reports.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import type { CivilDate } from '../common/time/gym-time';
import type { ReportRangeQueryDto } from './dto/report-range-query.dto';

const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;
const RANGE = { from: '2026-07-01' as CivilDate, to: '2026-09-30' as CivilDate } as ReportRangeQueryDto;

// `revenue` resolves its window through `this.window(query, now)` now, so the
// clock is injected. RANGE sends both bounds, so `now` only ever matters if a
// bound goes missing — the defaults themselves are pinned in reports-range.spec.
const NOW = new Date('2026-09-30T00:00:00.000Z');

const row = (
  day: string,
  netCentavos: number,
  extra: Partial<{ planCode: string; planName: string; method: string; purpose: string; discountCentavos: number }> = {},
) => ({
  businessDate: new Date(`${day}T00:00:00.000Z`),
  netCentavos,
  planCode: extra.planCode ?? 'MONTHLY',
  planName: extra.planName ?? 'Monthly',
  method: extra.method ?? 'CASH',
  purpose: extra.purpose ?? 'MEMBERSHIP',
  discountCentavos: extra.discountCentavos ?? 0,
});

describe('ReportsService.revenue', () => {
  const findMany = jest.fn();
  const prisma = { payment: { findMany } } as unknown as PrismaService;
  const service = new ReportsService(prisma, gym);

  beforeEach(() => findMany.mockReset());

  it('buckets by month, oldest first', async () => {
    findMany.mockResolvedValue([
      row('2026-07-04', 80_000),
      row('2026-07-20', 80_000),
      row('2026-08-02', 220_000),
    ]);

    const report = await service.revenue(RANGE, 'month', NOW);

    expect(report.series.map((s) => s.key)).toEqual(['2026-07', '2026-08']);
    expect(report.series[0]?.centavos).toBe(160_000);
    expect(report.series[0]?.count).toBe(2);
    expect(report.totalCentavos).toBe(380_000);
    expect(report.totalCount).toBe(3);
  });

  /**
   * A breakdown answers "what earns most", so the biggest bucket goes first.
   * A time series answers "what happened", so it stays chronological. Sorting
   * both the same way makes one of them useless.
   */
  it('sorts a breakdown by size, not by key', async () => {
    findMany.mockResolvedValue([
      row('2026-07-04', 9_000, { planCode: 'WALKIN', planName: 'Walk-in' }),
      row('2026-07-05', 750_000, { planCode: 'ANNUAL', planName: 'Annual' }),
      row('2026-07-06', 80_000),
    ]);

    const report = await service.revenue(RANGE, 'plan', NOW);

    expect(report.series.map((s) => s.label)).toEqual(['Annual', 'Monthly', 'Walk-in']);
  });

  it('groups by method and by purpose', async () => {
    findMany.mockResolvedValue([
      row('2026-07-04', 80_000, { method: 'CASH' }),
      row('2026-07-05', 80_000, { method: 'GCASH' }),
      row('2026-07-06', 80_000, { method: 'GCASH' }),
    ]);

    const byMethod = await service.revenue(RANGE, 'method', NOW);

    expect(byMethod.series[0]).toMatchObject({ key: 'GCASH', centavos: 160_000, count: 2 });
  });

  it('carries discounts alongside net, so a cheap month is explicable', async () => {
    findMany.mockResolvedValue([
      row('2026-07-04', 64_000, { discountCentavos: 16_000 }),
      row('2026-07-05', 80_000),
    ]);

    const report = await service.revenue(RANGE, 'month', NOW);

    expect(report.totalDiscountCentavos).toBe(16_000);
  });

  /**
   * A voided payment did not happen. Counting it at zero would leave the
   * money right and the transaction count wrong — and the count is what says
   * whether a quiet month was fewer sales or cheaper ones.
   */
  it('asks the database for RECORDED rows only', async () => {
    findMany.mockResolvedValue([]);

    await service.revenue(RANGE, 'month', NOW);

    const [args] = findMany.mock.calls[0] as [{ where: { status: string } }];
    expect(args.where.status).toBe('RECORDED');
  });

  it('returns an empty series rather than failing on a quiet range', async () => {
    findMany.mockResolvedValue([]);

    const report = await service.revenue(RANGE, 'month', NOW);

    expect(report.series).toEqual([]);
    expect(report.totalCentavos).toBe(0);
  });
});

describe('ReportsService.recurring', () => {
  const membershipFindMany = jest.fn();
  const membershipCount = jest.fn();
  const eventCount = jest.fn();
  const prisma = {
    membership: { findMany: membershipFindMany, count: membershipCount },
    membershipEvent: { count: eventCount },
  } as unknown as PrismaService;
  const service = new ReportsService(prisma, gym);

  beforeEach(() => {
    membershipFindMany.mockReset();
    membershipCount.mockReset();
    eventCount.mockReset();
    membershipCount.mockResolvedValue(0);
    eventCount.mockResolvedValue(0);
  });

  /**
   * MRR IS NORMALISED, NOT SUMMED.
   *
   * An annual plan is not twelve times a monthly one in the month it sells.
   * Summing list prices would show a spike and then two empty months for a
   * quarterly, which is exactly the shape that makes a recurring-revenue
   * number worthless.
   */
  it('normalises every plan to a monthly figure', async () => {
    membershipFindMany.mockResolvedValue([
      { planPriceCentavos: 80_000, termMonths: 1 },
      { planPriceCentavos: 220_000, termMonths: 3 },
      { planPriceCentavos: 750_000, termMonths: 12 },
    ]);

    const report = await service.recurring('2026-09-15' as CivilDate);

    // 80,000 + 73,333 + 62,500
    expect(report.mrrCentavos).toBe(215_833);
    expect(report.activeMembers).toBe(3);
    expect(report.arpuCentavos).toBe(71_944);
  });

  it('does not divide by zero on a gym with no members', async () => {
    membershipFindMany.mockResolvedValue([]);

    const report = await service.recurring('2026-09-15' as CivilDate);

    expect(report.mrrCentavos).toBe(0);
    expect(report.arpuCentavos).toBe(0);
  });

  it('computes churn against the terms that actually came up', async () => {
    membershipFindMany.mockResolvedValue([{ planPriceCentavos: 80_000, termMonths: 1 }]);
    membershipCount.mockResolvedValue(3); // lapsed
    eventCount.mockResolvedValue(7); // renewed

    const report = await service.recurring('2026-09-15' as CivilDate);

    expect(report.churnRate).toBeCloseTo(0.3, 4);
  });

  /** "No churn" and "nothing to churn" are different facts. */
  it('reports null churn when no term came up at all', async () => {
    membershipFindMany.mockResolvedValue([{ planPriceCentavos: 80_000, termMonths: 1 }]);

    const report = await service.recurring('2026-09-15' as CivilDate);

    expect(report.churnRate).toBeNull();
  });
});
