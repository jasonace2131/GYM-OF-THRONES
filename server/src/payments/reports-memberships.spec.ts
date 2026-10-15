import { ReportsService } from './reports.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';

/**
 * `GET /reports/memberships` — membership MOVEMENT in a window.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BOUNDARY TEST IS THE MOST IMPORTANT ONE IN THIS FILE.
 *
 * `MembershipEvent.effectiveAt` is `@db.Timestamptz(3)` — an INSTANT, not a
 * `@db.Date`. `toDateColumn('2026-09-22')` is 2026-09-22T00:00Z, which in
 * Manila is 8 AM on the 22nd: filtering an instant column with it silently
 * drops every event between midnight and 8 AM gym-local and picks up the
 * previous evening's instead. The window must be built with `gymDayWindow`,
 * and these three cases are what proves it was.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The other rule under test is COLUMN-AT-THE-TIME: plan and money come from
 * the joined Payment, because `Membership`'s snapshot columns describe the
 * CURRENT term. A March renewal read off the membership row would print
 * today's plan name — right-looking and wrong.
 */

const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;
const NOW = new Date('2026-09-22T00:00:00.000Z');
const WINDOW = { from: '2026-09-01', to: '2026-09-22' };

let nextId = 0;

interface EventOptions {
  type?: string;
  /** The joined Payment, or null for an event no money caused. */
  payment?: { netCentavos: number; status: string; planCode: string; planName: string } | null;
  /** The membership row's CURRENT snapshot — deliberately different. */
  snapshotPlanCode?: string;
  snapshotPlanName?: string;
  newEndsOn?: string | null;
  memberCode?: string | null;
}

/** One row shaped as the `findMany` in `membershipActivity` selects it. */
function event(effectiveAt: string, options: EventOptions = {}) {
  nextId += 1;
  return {
    id: `evt-${nextId}`,
    membershipId: `mem-${nextId}`,
    type: options.type ?? 'PURCHASED',
    effectiveAt: new Date(effectiveAt),
    newEndsOn:
      options.newEndsOn === undefined || options.newEndsOn === null
        ? null
        : new Date(`${options.newEndsOn}T00:00:00.000Z`),
    membership: {
      planCode: options.snapshotPlanCode ?? 'ANNUAL',
      planName: options.snapshotPlanName ?? 'Annual',
      user: {
        firstName: 'Jon',
        lastName: 'Snow',
        memberCode: options.memberCode === undefined ? 'GOT-0001' : options.memberCode,
      },
    },
    payment:
      options.payment === undefined
        ? { netCentavos: 80_000, status: 'RECORDED', planCode: 'MONTHLY', planName: 'Monthly' }
        : options.payment,
  };
}

describe('ReportsService.membershipActivity', () => {
  const findMany = jest.fn();
  const prisma = { membershipEvent: { findMany } } as unknown as PrismaService;
  const service = new ReportsService(prisma, gym);

  beforeEach(() => {
    nextId = 0;
    findMany.mockReset();
    findMany.mockResolvedValue([]);
  });

  /** The `where.effectiveAt` the service handed Prisma. */
  const whereWindow = (): { gte: Date; lt: Date } =>
    findMany.mock.calls[0]?.[0]?.where?.effectiveAt as { gte: Date; lt: Date };

  describe('the gym-day boundary', () => {
    it('queries instants, not @db.Date midnights', async () => {
      await service.membershipActivity(WINDOW, NOW);
      const { gte, lt } = whereWindow();

      // 2026-09-01 00:00 Manila is 2026-08-31 16:00 UTC. A `toDateColumn`
      // window would start at 2026-09-01T00:00Z — eight hours late.
      expect(gte.toISOString()).toBe('2026-08-31T16:00:00.000Z');
      // Exclusive end: the instant 2026-09-23 00:00 Manila begins.
      expect(lt.toISOString()).toBe('2026-09-22T16:00:00.000Z');
    });

    it('includes 00:30 Manila on the `to` day', async () => {
      await service.membershipActivity(WINDOW, NOW);
      const { gte, lt } = whereWindow();

      // 2026-09-22 00:30 Manila === 2026-09-21T16:30Z.
      const instant = new Date('2026-09-21T16:30:00.000Z');
      expect(instant >= gte && instant < lt).toBe(true);
    });

    it('includes 23:30 Manila on the `to` day', async () => {
      await service.membershipActivity(WINDOW, NOW);
      const { gte, lt } = whereWindow();

      // 2026-09-22 23:30 Manila === 2026-09-22T15:30Z.
      const instant = new Date('2026-09-22T15:30:00.000Z');
      expect(instant >= gte && instant < lt).toBe(true);
    });

    it('excludes 00:30 Manila on the day AFTER `to`', async () => {
      await service.membershipActivity(WINDOW, NOW);
      const { gte, lt } = whereWindow();

      // 2026-09-23 00:30 Manila === 2026-09-22T16:30Z.
      const instant = new Date('2026-09-22T16:30:00.000Z');
      expect(instant >= gte && instant < lt).toBe(false);
    });

    it('stamps businessDate from the gym-local day of the instant', async () => {
      // 2026-09-22T15:30Z is 23:30 on the 22nd in Manila — the 23rd in UTC.
      findMany.mockResolvedValue([event('2026-09-22T15:30:00.000Z')]);

      const report = await service.membershipActivity(WINDOW, NOW);

      expect(report.items[0]?.businessDate).toBe('2026-09-22');
    });
  });

  it('asks Prisma for only the five reportable types', async () => {
    await service.membershipActivity(WINDOW, NOW);

    // Holds, corrections, adjustments and imports are not MOVEMENT: a
    // HOLD_APPLIED is the same member on the same plan, and a
    // STATUS_CORRECTED is somebody fixing a mistake. Counting them as
    // activity would inflate every figure on the panel.
    expect(findMany.mock.calls[0]?.[0]?.where?.type).toEqual({
      in: ['PURCHASED', 'RENEWED', 'REACTIVATED', 'CANCELLED', 'EXPIRED'],
    });
  });

  it('takes plan from the joined Payment, not the membership snapshot', async () => {
    findMany.mockResolvedValue([
      event('2026-09-10T02:00:00.000Z', {
        type: 'RENEWED',
        payment: {
          netCentavos: 80_000,
          status: 'RECORDED',
          planCode: 'MONTHLY',
          planName: 'Monthly',
        },
        snapshotPlanCode: 'ANNUAL',
        snapshotPlanName: 'Annual',
      }),
    ]);

    const report = await service.membershipActivity(WINDOW, NOW);

    // The member is on Annual TODAY. In September they renewed a Monthly.
    expect(report.items[0]?.planName).toBe('Monthly');
    expect(report.items[0]?.planCode).toBe('MONTHLY');
  });

  it('falls back to the membership snapshot when the event had no payment', async () => {
    findMany.mockResolvedValue([
      event('2026-09-10T02:00:00.000Z', {
        type: 'EXPIRED',
        payment: null,
        snapshotPlanName: 'Annual',
        snapshotPlanCode: 'ANNUAL',
      }),
    ]);

    const report = await service.membershipActivity(WINDOW, NOW);

    expect(report.items[0]?.planName).toBe('Annual');
    // Null, not 0: "no money changed hands" and "it cost nothing" are
    // different facts, and the column renders them differently.
    expect(report.items[0]?.netCentavos).toBeNull();
  });

  it('keeps a VOIDED payment as a row but contributes nothing to revenue', async () => {
    findMany.mockResolvedValue([
      event('2026-09-10T02:00:00.000Z', {
        payment: {
          netCentavos: 80_000,
          status: 'VOIDED',
          planCode: 'MONTHLY',
          planName: 'Monthly',
        },
      }),
      event('2026-09-11T02:00:00.000Z', {
        payment: {
          netCentavos: 50_000,
          status: 'RECORDED',
          planCode: 'MONTHLY',
          planName: 'Monthly',
        },
      }),
    ]);

    const report = await service.membershipActivity(WINDOW, NOW);

    // The same rule walkInStats already applies: the membership moved, the
    // money was reversed.
    expect(report.items).toHaveLength(2);
    expect(report.revenueCentavos).toBe(50_000);
  });

  it('counts per type, and the counts sum to items.length', async () => {
    findMany.mockResolvedValue([
      event('2026-09-02T02:00:00.000Z', { type: 'PURCHASED' }),
      event('2026-09-03T02:00:00.000Z', { type: 'RENEWED' }),
      event('2026-09-04T02:00:00.000Z', { type: 'RENEWED' }),
      event('2026-09-05T02:00:00.000Z', { type: 'EXPIRED', payment: null }),
    ]);

    const report = await service.membershipActivity(WINDOW, NOW);

    expect(report.counts).toEqual({
      PURCHASED: 1,
      RENEWED: 2,
      REACTIVATED: 0,
      CANCELLED: 0,
      EXPIRED: 1,
    });
    const summed = Object.values(report.counts).reduce((sum, n) => sum + n, 0);
    expect(summed).toBe(report.items.length);
    expect(report.total).toBe(4);
  });

  it('asks for the newest first, with id as the tiebreak', async () => {
    await service.membershipActivity(WINDOW, NOW);

    // Two events can share an effectiveAt to the millisecond — a nightly
    // catch-up run writes a batch of them. Without a second key the page
    // order is whatever Postgres felt like, and it can differ between two
    // identical requests.
    expect(findMany.mock.calls[0]?.[0]?.orderBy).toEqual([
      { effectiveAt: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('reports truncated when the 2000-row ceiling is hit exactly', async () => {
    const rows = Array.from({ length: 2000 }, (_, index) =>
      event(new Date(Date.UTC(2026, 8, 10, 2, 0, index % 60)).toISOString()),
    );
    findMany.mockResolvedValue(rows);

    const report = await service.membershipActivity(WINDOW, NOW);

    expect(findMany.mock.calls[0]?.[0]?.take).toBe(2000);
    expect(report.truncated).toBe(true);
    expect(report.total).toBe(2000);
  });

  it('is not truncated below the ceiling', async () => {
    findMany.mockResolvedValue([event('2026-09-10T02:00:00.000Z')]);

    const report = await service.membershipActivity(WINDOW, NOW);

    expect(report.truncated).toBe(false);
  });

  it('names the member and carries the term end the event moved to', async () => {
    findMany.mockResolvedValue([
      event('2026-09-10T02:00:00.000Z', { type: 'RENEWED', newEndsOn: '2026-10-10' }),
    ]);

    const report = await service.membershipActivity(WINDOW, NOW);

    expect(report.items[0]).toMatchObject({
      memberName: 'Jon Snow',
      memberCode: 'GOT-0001',
      type: 'RENEWED',
      newEndsOn: '2026-10-10',
    });
  });
});
