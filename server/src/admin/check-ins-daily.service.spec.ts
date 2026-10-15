import { HttpStatus } from '@nestjs/common';
import { asCivilDate } from '../common/time/gym-time';
import { DomainException } from '../common/exceptions/domain.exception';
import { CheckInsDailyService, MAX_RANGE_DAYS } from './check-ins-daily.service';

/**
 * The four rules in the service header, one describe block each. Prisma is a
 * stub because none of these are questions about the database — they are
 * questions about what the service does with what the database returns.
 */

type VisitRow = { businessDate: Date; method: string; _count: { _all: number } };
type DenialRow = { businessDate: Date; _count: { _all: number } };

function build(visits: VisitRow[] = [], denials: DenialRow[] = []) {
  const checkIn = { groupBy: jest.fn().mockResolvedValue(visits) };
  const checkInDenial = { groupBy: jest.fn().mockResolvedValue(denials) };
  const prisma = { checkIn, checkInDenial } as never;
  return { service: new CheckInsDailyService(prisma), checkIn, checkInDenial };
}

/** Prisma returns a `@db.Date` column as a JS Date at UTC midnight. */
function dateColumn(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

const range = (from: string, to: string) => ({ from: asCivilDate(from), to: asCivilDate(to) });

describe('CheckInsDailyService', () => {
  describe('the result is dense', () => {
    it('returns every day in the range, including ones with no visits', async () => {
      const { service } = build([
        { businessDate: dateColumn('2026-08-20'), method: 'STATION_QR', _count: { _all: 4 } },
        { businessDate: dateColumn('2026-08-23'), method: 'STATION_QR', _count: { _all: 7 } },
      ]);

      const result = await service.daily(range('2026-08-20', '2026-08-24'));

      expect(result.days.map((d) => d.date)).toEqual([
        '2026-08-20',
        '2026-08-21',
        '2026-08-22',
        '2026-08-23',
        '2026-08-24',
      ]);
      // The gap is the whole point: a sparse series lets a line chart
      // interpolate straight across a closed day.
      expect(result.days.map((d) => d.total)).toEqual([4, 0, 0, 7, 0]);
    });

    it('returns a single day when both bounds are the same date', async () => {
      const { service } = build();
      const result = await service.daily(range('2026-08-24', '2026-08-24'));
      expect(result.days).toHaveLength(1);
      expect(result.days[0]).toEqual({
        date: '2026-08-24',
        total: 0,
        selfScan: 0,
        staff: 0,
        denied: 0,
      });
    });
  });

  describe('grouping', () => {
    it('splits self-scans from staff-recorded entries, and they sum to the total', async () => {
      const { service } = build([
        { businessDate: dateColumn('2026-08-24'), method: 'STATION_QR', _count: { _all: 9 } },
        { businessDate: dateColumn('2026-08-24'), method: 'MEMBER_CODE', _count: { _all: 2 } },
        { businessDate: dateColumn('2026-08-24'), method: 'MANUAL', _count: { _all: 3 } },
      ]);

      const [day] = (await service.daily(range('2026-08-24', '2026-08-24'))).days;

      expect(day).toMatchObject({ total: 14, selfScan: 9, staff: 5 });
      expect(day!.selfScan + day!.staff).toBe(day!.total);
    });

    it('counts denials from their own table, not as visits', async () => {
      const { service } = build(
        [{ businessDate: dateColumn('2026-08-24'), method: 'STATION_QR', _count: { _all: 6 } }],
        [{ businessDate: dateColumn('2026-08-24'), _count: { _all: 2 } }],
      );

      const [day] = (await service.daily(range('2026-08-24', '2026-08-24'))).days;

      expect(day).toMatchObject({ total: 6, denied: 2 });
    });
  });

  describe('the query it issues', () => {
    it('groups on businessDate and excludes voided rows', async () => {
      const { service, checkIn } = build();
      await service.daily(range('2026-08-01', '2026-08-24'));

      const [args] = checkIn.groupBy.mock.calls[0] as [Record<string, never>];
      expect(args).toMatchObject({
        by: ['businessDate', 'method'],
        where: { voidedAt: null },
      });
      // Guards rule 1. Grouping on `occurredAt` splits a Manila day at 08:00
      // local and is wrong every single day, plausibly.
      expect(JSON.stringify(args)).not.toContain('occurredAt');
    });

    it('issues exactly two queries regardless of range length', async () => {
      const { service, checkIn, checkInDenial } = build();
      await service.daily(range('2026-06-01', '2026-08-24'));

      // An N+1 introduced later fails here rather than in production.
      expect(checkIn.groupBy).toHaveBeenCalledTimes(1);
      expect(checkInDenial.groupBy).toHaveBeenCalledTimes(1);
    });
  });

  describe('range validation', () => {
    it('rejects a range whose end precedes its start', async () => {
      const { service } = build();
      await expect(service.daily(range('2026-08-24', '2026-08-01'))).rejects.toBeInstanceOf(
        DomainException,
      );
    });

    it('rejects a range wider than the cap', async () => {
      const { service } = build();
      const error = await service.daily(range('2026-01-01', '2026-08-24')).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe('REPORT_RANGE_INVALID');
      expect((error as DomainException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    });

    it('accepts a range of exactly the cap, inclusive of both bounds', async () => {
      const { service } = build();
      // 2026-06-01 → 2026-08-29 is 90 days counting both ends.
      const result = await service.daily(range('2026-06-01', '2026-08-29'));
      expect(result.days).toHaveLength(MAX_RANGE_DAYS);
    });

    it('does not touch the database when the range is rejected', async () => {
      const { service, checkIn } = build();
      await service.daily(range('2020-01-01', '2026-08-24')).catch(() => undefined);
      expect(checkIn.groupBy).not.toHaveBeenCalled();
    });
  });
});
