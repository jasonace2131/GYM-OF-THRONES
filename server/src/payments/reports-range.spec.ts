import { REPORT_MAX_RANGE_DAYS } from '@got/shared';
import { ReportsService } from './reports.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { addDays, asCivilDate } from '../common/time/gym-time';

/**
 * Every ranged report resolves its window the same way, or it does not.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THESE METHODS USED TO CALL `asCivilDate(query.from)` DIRECTLY.
 *
 * That meant: both bounds mandatory, a reversed window silently returning
 * nothing, a `2026-02-31` throwing a bare RangeError into the 500 handler,
 * and NO WIDTH CAP AT ALL on `walkInStats`, which does an uncapped findMany
 * and reduces in JS. Four copies of a rule is four chances to fix three.
 *
 * Parameterised on purpose: adding a fifth ranged report and forgetting to
 * route it through `this.window()` should fail HERE, by being absent from the
 * list below, rather than in production with a ten-year query.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `now` is injected, so "today" is a fixture rather than the wall clock and
 * the defaults assertion does not go red once a day at midnight Manila.
 */

const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;

// 08:00 Manila on 2026-09-22. Mid-morning, so the gym-local date and the UTC
// date agree and a reader need not work out which one the fixture means.
const NOW = new Date('2026-09-22T00:00:00.000Z');
const TODAY = asCivilDate('2026-09-22');

interface Window {
  from?: string;
  to?: string;
}

const REPORTS: {
  name: string;
  run: (service: ReportsService, query: Window) => Promise<{ from: string; to: string }>;
  /** The one prisma delegate the method reads, stubbed empty. */
  stub: (findMany: jest.Mock) => PrismaService;
}[] = [
  {
    name: 'statutoryDiscounts',
    run: (service, query) => service.statutoryDiscounts(query, NOW),
    stub: (findMany) => ({ payment: { findMany } }) as unknown as PrismaService,
  },
  {
    name: 'gcashReferences',
    run: (service, query) => service.gcashReferences(query, NOW),
    stub: (findMany) => ({ payment: { findMany } }) as unknown as PrismaService,
  },
  {
    name: 'walkInStats',
    run: (service, query) => service.walkInStats(query, NOW),
    stub: (findMany) => ({ checkIn: { findMany } }) as unknown as PrismaService,
  },
  {
    name: 'revenue',
    run: (service, query) => service.revenue(query, 'month', NOW),
    stub: (findMany) => ({ payment: { findMany } }) as unknown as PrismaService,
  },
  {
    name: 'membershipActivity',
    run: (service, query) => service.membershipActivity(query, NOW),
    stub: (findMany) => ({ membershipEvent: { findMany } }) as unknown as PrismaService,
  },
];

describe.each(REPORTS)('ReportsService.$name — range handling', ({ run, stub }) => {
  const findMany = jest.fn();
  const service = new ReportsService(stub(findMany), gym);

  /** The DomainException code a call rejects with, or a failure if it resolves. */
  const codeFrom = async (query: Window): Promise<string> => {
    try {
      await run(service, query);
    } catch (caught) {
      if (caught instanceof DomainException) return caught.code;
      throw caught;
    }
    throw new Error('expected a DomainException, but the call resolved');
  };

  beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
  });

  it('refuses a reversed window', async () => {
    await expect(codeFrom({ from: '2026-09-20', to: '2026-09-01' })).resolves.toBe(
      'DATE_RANGE_INVALID',
    );
  });

  it('refuses a window one day wider than the cap', async () => {
    // Counted as resolveDateWindow counts: the days BETWEEN the two inclusive
    // bounds. 367 between is refused; 366 between (below) resolves.
    const to = addDays(asCivilDate('2026-01-01'), REPORT_MAX_RANGE_DAYS + 1);
    await expect(codeFrom({ from: '2026-01-01', to })).resolves.toBe('DATE_RANGE_INVALID');
  });

  it('allows a window exactly at the cap', async () => {
    const to = addDays(asCivilDate('2026-01-01'), REPORT_MAX_RANGE_DAYS);
    await expect(run(service, { from: '2026-01-01', to })).resolves.toMatchObject({
      from: '2026-01-01',
      to,
    });
  });

  it('refuses a date that is not on the calendar', async () => {
    await expect(codeFrom({ from: '2026-02-31', to: '2026-03-01' })).resolves.toBe(
      'DATE_RANGE_INVALID',
    );
  });

  it('defaults to the last 30 days, inclusive, when neither bound is sent', async () => {
    // [today-29, today] is thirty days counting both ends — the window the
    // client's '30d' preset asks for, so the two cannot disagree.
    await expect(run(service, {})).resolves.toMatchObject({
      from: addDays(TODAY, -29),
      to: TODAY,
    });
  });

  it('keeps a sent `to` and defaults only the missing `from`', async () => {
    await expect(run(service, { to: '2026-09-10' })).resolves.toMatchObject({
      from: addDays(TODAY, -29),
      to: '2026-09-10',
    });
  });

  it('keeps a sent `from` and defaults only the missing `to`', async () => {
    await expect(run(service, { from: '2026-09-01' })).resolves.toMatchObject({
      from: '2026-09-01',
      to: TODAY,
    });
  });
});
