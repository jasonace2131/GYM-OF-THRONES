import { NotFoundException } from '@nestjs/common';
import type { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import type { CivilDate } from '../common/time/gym-time';
import type { MembershipService } from '../membership/membership.service';
import type { PrismaService } from '../prisma/prisma.service';
import { CheckInsReportService, type CheckInReach } from './check-ins-report.service';
import type { ListCheckInsQueryDto } from './dto/list-check-ins-query.dto';

const COACH = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const ALL: CheckInReach = { scope: 'ALL', callerId: '11111111-1111-4111-8111-111111111111' };
const OWN: CheckInReach = { scope: 'OWN', callerId: COACH };
const day = (d: string): CivilDate => d as CivilDate;

describe('CheckInsReportService (attendance history, 2026-11-09)', () => {
  const findMany = jest.fn();
  const findFirst = jest.fn();
  const count = jest.fn();
  const groupBy = jest.fn();
  const denialsFindMany = jest.fn();
  const denialsCount = jest.fn();
  const prisma = {
    checkIn: { findMany, findFirst, count, groupBy },
    checkInDenial: { findMany: denialsFindMany, count: denialsCount },
    $transaction: jest.fn((ops: Array<Promise<unknown>>) => Promise.all(ops)),
  } as unknown as PrismaService;
  const gym = {
    timeZone: 'Asia/Manila',
    expiringSoonDays: 7,
    graceAdmissionsMax: 3,
  } as unknown as GymConfigService;
  const service = new CheckInsReportService(prisma, gym, {} as MembershipService);

  const query = (over: Partial<ListCheckInsQueryDto> = {}): ListCheckInsQueryDto => ({
    page: 1,
    limit: 25,
    ...over,
  });
  /** The `where` a mocked Prisma call received, typed so the test reads it safely. */
  const whereOf = (mock: jest.Mock, call = 0): Record<string, unknown> =>
    (mock.mock.calls as Array<[{ where: Record<string, unknown> }]>)[call][0].where;
  const whereOfList = (): Record<string, unknown> => whereOf(findMany);

  beforeEach(() => {
    for (const fn of [findMany, findFirst, count, groupBy, denialsFindMany, denialsCount]) {
      fn.mockReset();
    }
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);
    groupBy.mockResolvedValue([]);
    denialsFindMany.mockResolvedValue([]);
    denialsCount.mockResolvedValue(0);
  });

  describe('who the caller reaches', () => {
    it('reads everyone at ALL, guests included (no member filter at all)', async () => {
      await service.list(query(), ALL);
      expect(whereOfList()).not.toHaveProperty('user');
    });

    it('reads only the members assigned to a coach at OWN', async () => {
      await service.list(query(), OWN);
      expect(whereOfList()).toMatchObject({
        user: { assignedCoach: { some: { coachId: COACH, endedAt: null } } },
      });
    });

    it('answers 404 for a visit out of reach, the same as a missing one', async () => {
      findFirst.mockResolvedValue(null);
      await expect(
        service.findOne('44444444-4444-4444-8444-444444444444', OWN),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(whereOf(findFirst)).toMatchObject({
        id: '44444444-4444-4444-8444-444444444444',
        user: { assignedCoach: { some: { coachId: COACH } } },
      });
    });

    it('narrows the denial list the same way', async () => {
      await service.listDenials({ page: 1, limit: 25 }, OWN);
      expect(whereOf(denialsFindMany)).toMatchObject({
        user: { assignedCoach: { some: { coachId: COACH } } },
      });
    });
  });

  describe('search', () => {
    it('needs every word to match a name, a member code or a guest name', async () => {
      await service.list(query({ q: 'ana  rey' }), ALL);
      const and = whereOfList().AND as Array<{ OR: unknown[] }>;
      expect(and).toHaveLength(2);
      expect(and[0].OR).toEqual([
        { user: { firstName: { contains: 'ana', mode: 'insensitive' } } },
        { user: { lastName: { contains: 'ana', mode: 'insensitive' } } },
        { user: { memberCode: { contains: 'ana', mode: 'insensitive' } } },
        { guestName: { contains: 'ana', mode: 'insensitive' } },
      ]);
      expect(JSON.stringify(and[1])).toContain('"rey"');
    });

    it('keeps the existing filters alongside it, and hides voided visits by default', async () => {
      await service.list(
        query({ entryType: 'WALK_IN', method: 'MANUAL', userId: MEMBER, openOnly: true }),
        ALL,
      );
      expect(whereOfList()).toMatchObject({
        entryType: 'WALK_IN',
        method: 'MANUAL',
        userId: MEMBER,
        endedAt: null,
        voidedAt: null,
      });
    });
  });

  describe('date window', () => {
    const refusal = (q: ListCheckInsQueryDto): Promise<unknown> => service.list(q, ALL);

    it('refuses a range that ends before it starts', async () => {
      await expect(
        refusal(query({ from: day('2026-11-09'), to: day('2026-11-01') })),
      ).rejects.toMatchObject({
        code: 'DATE_RANGE_INVALID',
      });
    });

    it('refuses more than a year for everyone, and allows it for one member', async () => {
      const long = { from: day('2024-01-01'), to: day('2026-11-09') };
      await expect(refusal(query(long))).rejects.toBeInstanceOf(DomainException);
      await expect(service.list(query({ ...long, userId: MEMBER }), ALL)).resolves.toBeDefined();
    });

    it('still allows a single bound, as before', async () => {
      await expect(service.list(query({ from: day('2025-01-01') }), ALL)).resolves.toBeDefined();
    });
  });

  describe('summary()', () => {
    it('needs a date range unless one member is chosen', async () => {
      await expect(service.summary({}, ALL)).rejects.toMatchObject({ code: 'DATE_RANGE_INVALID' });
      await expect(service.summary({ userId: MEMBER }, ALL)).resolves.toBeDefined();
    });

    it('counts visits, people and types, and averages only timed visits', async () => {
      count.mockResolvedValueOnce(5).mockResolvedValueOnce(1); // visits, then guest visits
      groupBy
        .mockResolvedValueOnce([
          { entryType: 'MEMBERSHIP', _count: { _all: 3 } },
          { entryType: 'WALK_IN', _count: { _all: 2 } },
        ])
        .mockResolvedValueOnce([{ userId: 'a' }, { userId: 'b' }]);
      const at = (iso: string): Date => new Date(iso);
      findMany.mockResolvedValueOnce([
        { occurredAt: at('2026-11-09T01:00:00Z'), endedAt: at('2026-11-09T02:00:00Z') },
        { occurredAt: at('2026-11-09T03:00:00Z'), endedAt: at('2026-11-09T03:30:00Z') },
      ]);

      const result = await service.summary(
        { from: day('2026-11-03'), to: day('2026-11-09'), includeVoided: true },
        ALL,
      );

      expect(result).toEqual({
        visits: 5,
        people: 3,
        byType: { MEMBERSHIP: 3, WALK_IN: 2, GUEST_PASS: 0 },
        averageMinutes: 45,
      });
      // Voided visits never count, even when the list is showing them.
      expect(whereOf(count)).toMatchObject({ voidedAt: null });
      expect(JSON.stringify(whereOf(findMany))).toContain('"autoClosed":false');
    });

    it('has no average when nothing was timed', async () => {
      findMany.mockResolvedValueOnce([]);
      const result = await service.summary({ userId: MEMBER }, ALL);
      expect(result.averageMinutes).toBeNull();
    });
  });
});
