import { OpeningHoursService } from './opening-hours.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from './gym.config';

const gym = {
  timeZone: 'Asia/Manila',
  openTime: '05:00',
  closeTime: '22:00',
} as unknown as GymConfigService;

const day = (dayOfWeek: number, opensAt = '06:00', closesAt = '23:00', isClosed = false) => ({
  dayOfWeek,
  opensAt,
  closesAt,
  isClosed,
  updatedById: null,
  updatedAt: new Date(),
});

describe('OpeningHoursService', () => {
  const findMany = jest.fn();
  const prisma = { openingHours: { findMany } } as unknown as PrismaService;

  // A no-op recorder: these tests are about which hours the door reads, not
  // about the audit line an edit leaves behind.
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;

  const build = (): OpeningHoursService => new OpeningHoursService(prisma, gym, audit);

  beforeEach(() => findMany.mockReset());

  it('uses the stored hours when the table has them', async () => {
    findMany.mockResolvedValue(Array.from({ length: 7 }, (_, d) => day(d)));

    const week = await build().week();

    expect(week).toHaveLength(7);
    expect(week[0]).toMatchObject({ opensAt: '06:00', closesAt: '23:00' });
  });

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * THE FALLBACK IS THE ENTIRE JUSTIFICATION FOR THIS TABLE EXISTING.
   *
   * `settings/page.tsx` argued hours belong in the environment because a bad
   * value crashes the deploy — loud, at a keyboard — where a bad database row
   * stops the front desk at 06:00 with a queue and no explanation.
   *
   * Making them editable is only defensible because every failure below still
   * lands on GYM_OPEN_TIME / GYM_CLOSE_TIME. If these tests ever go, the
   * argument against the whole feature comes back.
   * ══════════════════════════════════════════════════════════════════════════
   */
  describe('falls back to the environment', () => {
    it('when the table is empty', async () => {
      findMany.mockResolvedValue([]);

      const week = await build().week();

      expect(week).toHaveLength(7);
      expect(week.every((d) => d.opensAt === '05:00' && d.closesAt === '22:00')).toBe(true);
    });

    it('when the query throws', async () => {
      findMany.mockRejectedValue(new Error('connection terminated'));

      const week = await build().week();

      expect(week.every((d) => d.opensAt === '05:00')).toBe(true);
    });

    it('for the one day a partial table is missing', async () => {
      // Wednesday absent. It must NOT come back as "closed on Wednesday".
      findMany.mockResolvedValue([0, 1, 2, 4, 5, 6].map((d) => day(d)));

      const week = await build().week();
      const wednesday = week.find((d) => d.dayOfWeek === 3);

      expect(wednesday).toMatchObject({ opensAt: '05:00', closesAt: '22:00', isClosed: false });
    });

    it('for a row whose time is malformed', async () => {
      findMany.mockResolvedValue([day(0, '25:99', '23:00'), ...[1, 2, 3, 4, 5, 6].map((d) => day(d))]);

      const week = await build().week();

      expect(week[0]).toMatchObject({ opensAt: '05:00', closesAt: '22:00' });
      // Only the broken row falls back; the rest are untouched.
      expect(week[1]).toMatchObject({ opensAt: '06:00' });
    });
  });

  /**
   * A closed day is the ONE way this table can shut the gym out, and it is a
   * decision somebody made on a screen that said so — not an accident of a
   * missing row or an unreachable database.
   */
  it('honours a day marked closed', async () => {
    findMany.mockResolvedValue([day(0, '06:00', '23:00', true), ...[1, 2, 3, 4, 5, 6].map((d) => day(d))]);

    const week = await build().week();

    expect(week[0]?.isClosed).toBe(true);
  });

  /**
   * A Railway container runs in UTC. At 23:30 in Manila it is already
   * tomorrow there, so a server-clock weekday would read Sunday's hours on a
   * Saturday night — and close the gym eight hours early.
   */
  it('resolves the weekday in the gym timezone, not the server one', async () => {
    findMany.mockResolvedValue(
      Array.from({ length: 7 }, (_, d) => day(d, `0${d}:00`, '23:00')),
    );

    // 2026-09-05T16:30Z is Saturday 00:30 in Manila — Saturday (6) there,
    // still Saturday (6) in UTC only by luck; use a time that actually differs.
    const service = build();
    const saturdayNightManila = new Date('2026-09-05T16:30:00.000Z');
    const today = await service.forDate(saturdayNightManila);

    // Manila is UTC+8, so this instant is Sunday 00:30 there → dayOfWeek 0.
    expect(today.dayOfWeek).toBe(0);
  });

  it('caches, so the door does not hit the database on every scan', async () => {
    findMany.mockResolvedValue(Array.from({ length: 7 }, (_, d) => day(d)));
    const service = build();

    await service.week();
    await service.week();

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('drops the cache after an edit, so a change reaches the door at once', async () => {
    findMany.mockResolvedValue(Array.from({ length: 7 }, (_, d) => day(d)));
    const service = build();

    await service.week();
    service.invalidate();
    await service.week();

    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
