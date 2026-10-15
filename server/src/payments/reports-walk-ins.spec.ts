import { ReportsService } from './reports.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';

/**
 * `averagePerDay`, and the line nobody may "fix".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * `spanDays` IS `civilDaysBetween(from, to) + 1`, AND THE +1 IS CORRECT.
 *
 * Both bounds are INCLUSIVE, so from === to is one day, not zero. Drop the
 * +1 and a single-day report divides by zero; the guard above it would then
 * quietly report 0 walk-ins per day on a day that had forty.
 *
 * It reads like an off-by-one, which is exactly why it keeps attracting
 * "fixes". The real off-by-one was on the CLIENT, where `shiftDays(7)` plus
 * two inclusive bounds asked for an EIGHT-day window and labelled it "Last 7
 * days" — every average on the screen was out by 7/8. That one is fixed in
 * `client/src/lib/reportRange.ts`; this one is pinned here.
 *
 * Every case below asserts `spanDays` THROUGH `averagePerDay`, because that
 * is the only way it is observable and therefore the only way a regression
 * is caught.
 * ─────────────────────────────────────────────────────────────────────────
 */

const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;
const NOW = new Date('2026-09-22T00:00:00.000Z');

/** A walk-in visit at a gym-local wall-clock time on a gym-local day. */
function visit(
  day: string,
  hhmm: string,
  extra: {
    netCentavos?: number;
    status?: 'RECORDED' | 'VOIDED';
    noPayment?: boolean;
    converted?: boolean;
  } = {},
) {
  // Manila is UTC+8 with no DST, so the instant is the wall clock minus 8h.
  const [hour, minute] = hhmm.split(':').map(Number);
  const occurredAt = new Date(`${day}T00:00:00.000Z`);
  occurredAt.setUTCHours((hour as number) - 8, minute as number, 0, 0);

  return {
    occurredAt,
    businessDate: new Date(`${day}T00:00:00.000Z`),
    convertedToUserId: extra.converted === true ? 'user-1' : null,
    payment:
      extra.noPayment === true
        ? null
        : { netCentavos: extra.netCentavos ?? 9_000, status: extra.status ?? 'RECORDED' },
  };
}

describe('ReportsService.walkInStats', () => {
  const findMany = jest.fn();
  const prisma = { checkIn: { findMany } } as unknown as PrismaService;
  const service = new ReportsService(prisma, gym);

  beforeEach(() => findMany.mockReset());

  it('counts a one-day range as ONE day, not zero and not two', async () => {
    findMany.mockResolvedValue([visit('2026-09-22', '18:00')]);

    const report = await service.walkInStats({ from: '2026-09-22', to: '2026-09-22' }, NOW);

    // 1 visit / 1 day. A `spanDays` of 0 would divide by zero and the guard
    // would report 0; a `spanDays` of 2 would report 0.5.
    expect(report.averagePerDay).toBe(1);
    expect(report.totalWalkIns).toBe(1);
  });

  it('counts 2026-09-16..2026-09-22 as SEVEN inclusive days', async () => {
    const days = [
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
    ];
    findMany.mockResolvedValue(days.map((day) => visit(day, '18:00')));

    const report = await service.walkInStats({ from: '2026-09-16', to: '2026-09-22' }, NOW);

    // 7 visits over 7 days. An 8-day window — the client bug — gives 0.9.
    expect(report.averagePerDay).toBe(1);
  });

  it('averages 14 visits over the same seven days to 2', async () => {
    const days = [
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
    ];
    findMany.mockResolvedValue(days.flatMap((day) => [visit(day, '09:00'), visit(day, '18:00')]));

    const report = await service.walkInStats({ from: '2026-09-16', to: '2026-09-22' }, NOW);

    expect(report.averagePerDay).toBe(2);
    expect(report.totalWalkIns).toBe(14);
  });

  /**
   * One visit across a month rounds to a flat 0 at one decimal place. That is
   * the server behaving correctly and the CLIENT's job to say gracefully —
   * `page.tsx` renders `<0.1` rather than a `0` sitting beside a tile reading
   * "1 total walk-ins". Pinned so the rounding is a decision, not an accident.
   */
  it('rounds one visit across thirty days to a flat 0', async () => {
    findMany.mockResolvedValue([visit('2026-09-10', '18:00')]);

    const report = await service.walkInStats({ from: '2026-08-24', to: '2026-09-22' }, NOW);

    expect(report.averagePerDay).toBe(0);
    expect(report.totalWalkIns).toBe(1);
  });

  it('counts a VOIDED payment as a visit but not as revenue', async () => {
    findMany.mockResolvedValue([
      visit('2026-09-22', '10:00', { netCentavos: 9_000, status: 'RECORDED' }),
      visit('2026-09-22', '11:00', { netCentavos: 9_000, status: 'VOIDED' }),
      // A GUEST_PASS entry: a visit with no payment at all.
      visit('2026-09-22', '12:00', { noPayment: true }),
    ]);

    const report = await service.walkInStats({ from: '2026-09-22', to: '2026-09-22' }, NOW);

    expect(report.totalWalkIns).toBe(3);
    expect(report.revenueCentavos).toBe(9_000);
  });

  it('orders byDay Monday-first and omits weekdays with no visits', async () => {
    findMany.mockResolvedValue([
      // 2026-09-20 is a Sunday, 2026-09-21 a Monday, 2026-09-22 a Tuesday.
      visit('2026-09-20', '10:00'),
      visit('2026-09-22', '10:00'),
      visit('2026-09-21', '10:00'),
    ]);

    const report = await service.walkInStats({ from: '2026-09-16', to: '2026-09-22' }, NOW);

    // Monday first: a week starting on Sunday reads as an American calendar
    // to a Philippine audience. Wednesday..Saturday had none and are absent
    // rather than present with a zero.
    expect(report.byDay.map((row) => row.weekday)).toEqual(['Monday', 'Tuesday', 'Sunday']);
  });

  it('reports the modal gym-local hour as peakHour', async () => {
    findMany.mockResolvedValue([
      visit('2026-09-22', '06:30'),
      visit('2026-09-22', '18:10'),
      visit('2026-09-22', '18:45'),
    ]);

    const report = await service.walkInStats({ from: '2026-09-22', to: '2026-09-22' }, NOW);

    // 18:00 Manila twice beats 06:00 once. Rendered gym-local: 21:00 UTC on
    // the 21st is what these instants are, and 6 PM is what the gym saw.
    expect(report.byDay[0]?.peakHour).toBe('6 PM');
  });

  it('counts conversions from CheckIn.convertedToUserId', async () => {
    findMany.mockResolvedValue([
      visit('2026-09-22', '10:00', { converted: true }),
      visit('2026-09-22', '11:00'),
    ]);

    const report = await service.walkInStats({ from: '2026-09-22', to: '2026-09-22' }, NOW);

    expect(report.converted).toBe(1);
  });
});
