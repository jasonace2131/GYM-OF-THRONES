import { AutoCloseVisitsJob, closingInstantFor, planAutoClose } from './auto-close-visits.job';
import type { PrismaService } from '../../prisma/prisma.service';
import type { GymConfigService } from '../../config/gym.config';
import type { DayHours, OpeningHoursService } from '../../config/opening-hours.service';
import type { SystemNotificationsService } from '../../notifications/system-notifications.service';
import { asCivilDate } from '../../common/time/gym-time';

const TZ = 'Asia/Manila';

/** Every day 05:00–22:00, Saturday (6) 06:00–20:00. */
function week(overrides: Partial<Record<number, Partial<DayHours>>> = {}): DayHours[] {
  return Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    opensAt: dayOfWeek === 6 ? '06:00' : '05:00',
    closesAt: dayOfWeek === 6 ? '20:00' : '22:00',
    isClosed: false,
    ...overrides[dayOfWeek],
  }));
}

function gym(): GymConfigService {
  return { timeZone: TZ, openTime: '05:00', closeTime: '22:00' } as unknown as GymConfigService;
}

/** 2026-09-25 is a Friday; 2026-09-26 a Saturday. */
const FRIDAY = asCivilDate('2026-09-25');
const SATURDAY = asCivilDate('2026-09-26');
const FRIDAY_COLUMN = new Date('2026-09-25T00:00:00.000Z');
const SATURDAY_COLUMN = new Date('2026-09-26T00:00:00.000Z');
/** 22:00 Manila on Friday. */
const FRIDAY_CLOSE = new Date('2026-09-25T14:00:00.000Z');
/** 20:00 Manila on Saturday. */
const SATURDAY_CLOSE = new Date('2026-09-26T12:00:00.000Z');

function visit(id: string, businessDate: Date, occurredAt: Date) {
  return { id, businessDate, occurredAt };
}

describe('closingInstantFor', () => {
  it("is that weekday's own closing time, as a real instant in the gym's zone", () => {
    expect(closingInstantFor(FRIDAY, week(), TZ, '23:00')).toEqual(FRIDAY_CLOSE);
    expect(closingInstantFor(SATURDAY, week(), TZ, '23:00')).toEqual(SATURDAY_CLOSE);
  });

  it('falls back to the environment close time when the week has no row for the day', () => {
    const noFriday = week().filter((day) => day.dayOfWeek !== 5);
    expect(closingInstantFor(FRIDAY, noFriday, TZ, '21:30')).toEqual(
      new Date('2026-09-25T13:30:00.000Z'),
    );
  });
});

describe('planAutoClose', () => {
  it('closes a visit left open on an earlier day at THAT day’s closing time', () => {
    const now = new Date('2026-09-26T01:00:00.000Z'); // 09:00 Saturday
    const plan = planAutoClose(
      [visit('a', FRIDAY_COLUMN, new Date('2026-09-25T10:00:00.000Z'))],
      week(),
      TZ,
      '22:00',
      now,
    );
    expect(plan).toEqual([{ id: 'a', endedAt: FRIDAY_CLOSE }]);
  });

  it('leaves today’s visits alone until closing time plus the fifteen-minute slack has passed', () => {
    const inside = [visit('b', SATURDAY_COLUMN, new Date('2026-09-26T09:00:00.000Z'))];

    // 20:10 Saturday — closed, but the last member may still be leaving.
    const tenPast = new Date('2026-09-26T12:10:00.000Z');
    expect(planAutoClose(inside, week(), TZ, '22:00', tenPast)).toEqual([]);
    // 20:15 Saturday — the gate itself stops at close + 15.
    const quarterPast = new Date('2026-09-26T12:15:00.000Z');
    expect(planAutoClose(inside, week(), TZ, '22:00', quarterPast)).toEqual([
      { id: 'b', endedAt: SATURDAY_CLOSE },
    ]);
  });

  it('uses each visit’s own business day, not today’s hours', () => {
    const now = new Date('2026-09-26T15:00:00.000Z'); // 23:00 Saturday
    const plan = planAutoClose(
      [
        visit('fri', FRIDAY_COLUMN, new Date('2026-09-25T11:00:00.000Z')),
        visit('sat', SATURDAY_COLUMN, new Date('2026-09-26T11:00:00.000Z')),
      ],
      week(),
      TZ,
      '22:00',
      now,
    );
    expect(plan).toEqual([
      { id: 'fri', endedAt: FRIDAY_CLOSE },
      { id: 'sat', endedAt: SATURDAY_CLOSE },
    ]);
  });

  it('never ends a visit before it began — one opened after closing ends where it started', () => {
    const late = new Date('2026-09-25T14:05:00.000Z'); // 22:05 Friday, desk-recorded
    const plan = planAutoClose(
      [visit('late', FRIDAY_COLUMN, late)],
      week(),
      TZ,
      '22:00',
      new Date('2026-09-26T01:00:00.000Z'),
    );
    expect(plan).toEqual([{ id: 'late', endedAt: late }]);
  });

  it('still closes a visit recorded on a day marked closed, at that day’s stored closing time', () => {
    const plan = planAutoClose(
      [visit('x', FRIDAY_COLUMN, new Date('2026-09-25T10:00:00.000Z'))],
      week({ 5: { isClosed: true } }),
      TZ,
      '22:00',
      new Date('2026-09-26T01:00:00.000Z'),
    );
    expect(plan).toEqual([{ id: 'x', endedAt: FRIDAY_CLOSE }]);
  });
});

describe('AutoCloseVisitsJob', () => {
  let findMany: jest.Mock;
  let updateMany: jest.Mock;
  let raise: jest.Mock;
  let hoursWeek: jest.Mock;
  let job: AutoCloseVisitsJob;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    updateMany = jest.fn().mockResolvedValue({ count: 0 });
    raise = jest.fn().mockResolvedValue(undefined);
    hoursWeek = jest.fn().mockResolvedValue(week());
    job = new AutoCloseVisitsJob(
      { checkIn: { findMany, updateMany } } as unknown as PrismaService,
      gym(),
      { week: hoursWeek } as unknown as OpeningHoursService,
      { raise } as unknown as SystemNotificationsService,
    );
    jest.useFakeTimers().setSystemTime(new Date('2026-09-26T01:00:00.000Z')); // 09:00 Saturday
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('identifies itself and runs every fifteen minutes', () => {
    expect(job.name).toBe('autoCloseVisits');
    expect(job.cronExpression).toBe('*/15 * * * *');
  });

  it('reads only visits that are still open and not voided, oldest first, bounded', async () => {
    await job.run();

    expect(findMany).toHaveBeenCalledWith({
      where: { endedAt: null, voidedAt: null },
      select: { id: true, businessDate: true, occurredAt: true },
      orderBy: [{ businessDate: 'asc' }, { occurredAt: 'asc' }],
      take: 2000,
    });
  });

  it('closes them as AUTO_CLOSE, clearing the sentinel, and only if still open when written', async () => {
    findMany.mockResolvedValue([
      visit('m1', FRIDAY_COLUMN, new Date('2026-09-25T10:00:00.000Z')),
      visit('g1', FRIDAY_COLUMN, new Date('2026-09-25T11:00:00.000Z')),
    ]);
    updateMany.mockResolvedValue({ count: 2 });

    await job.run();

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      // Guarded on the visit STILL being open: a desk check-out that landed
      // between the read and this write wins, and is never overwritten.
      where: { id: { in: ['m1', 'g1'] }, endedAt: null, voidedAt: null },
      data: {
        endedAt: FRIDAY_CLOSE,
        closeMethod: 'AUTO_CLOSE',
        // `CheckIn_autoclosed_agrees` and `CheckIn_open_marker_agrees`: the
        // flag and the sentinel move in the same statement as the close.
        autoClosed: true,
        openUserId: null,
      },
    });
  });

  it('writes one statement per distinct closing instant', async () => {
    findMany.mockResolvedValue([
      visit('fri', FRIDAY_COLUMN, new Date('2026-09-25T10:00:00.000Z')),
      visit('late', FRIDAY_COLUMN, new Date('2026-09-25T14:05:00.000Z')),
    ]);
    updateMany.mockResolvedValue({ count: 1 });

    await job.run();

    expect(updateMany).toHaveBeenCalledTimes(2);
    const calls = updateMany.mock.calls as [{ data: { endedAt: Date } }][];
    expect(calls.map(([arg]) => arg.data.endedAt)).toEqual([
      FRIDAY_CLOSE,
      new Date('2026-09-25T14:05:00.000Z'),
    ]);
  });

  it('is idempotent: with nothing open it writes nothing and raises nothing', async () => {
    await job.run();
    await job.run();

    expect(updateMany).not.toHaveBeenCalled();
    expect(raise).not.toHaveBeenCalled();
  });

  it('writes nothing and raises nothing while today’s visits are still inside', async () => {
    jest.setSystemTime(new Date('2026-09-26T09:00:00.000Z')); // 17:00 Saturday
    findMany.mockResolvedValue([visit('s', SATURDAY_COLUMN, new Date('2026-09-26T08:00:00.000Z'))]);

    await job.run();

    expect(updateMany).not.toHaveBeenCalled();
    expect(raise).not.toHaveBeenCalled();
  });

  it('tells the console how many visits it closed, pointing at the walk-in register', async () => {
    findMany.mockResolvedValue([visit('g1', FRIDAY_COLUMN, new Date('2026-09-25T11:00:00.000Z'))]);
    updateMany.mockResolvedValue({ count: 1 });

    await job.run();

    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'NIGHTLY_JOB',
        severity: 'INFO',
        title: '1 visit still open at closing was checked out automatically',
        linkPath: '/admin/walk-ins',
        subjectType: 'AutoCloseVisitsJob',
      }),
    );
  });

  it('counts what was actually closed, not what was read — a visit closed by hand in between is not claimed', async () => {
    findMany.mockResolvedValue([
      visit('a', FRIDAY_COLUMN, new Date('2026-09-25T10:00:00.000Z')),
      visit('b', FRIDAY_COLUMN, new Date('2026-09-25T10:30:00.000Z')),
    ]);
    updateMany.mockResolvedValue({ count: 1 });
    const log = jest.spyOn(job['logger'], 'log').mockImplementation(() => undefined);

    await job.run();

    expect(log.mock.calls[0][0]).toContain('matched=2');
    expect(log.mock.calls[0][0]).toContain('closed=1');
    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '1 visit still open at closing was checked out automatically',
      }),
    );
  });

  it('raises a critical notice and rethrows when the write fails, so the scheduler still logs it', async () => {
    findMany.mockResolvedValue([visit('a', FRIDAY_COLUMN, new Date('2026-09-25T10:00:00.000Z'))]);
    updateMany.mockRejectedValue(new Error('connection terminated'));

    await expect(job.run()).rejects.toThrow('connection terminated');
    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'NIGHTLY_JOB_FAILED', severity: 'CRITICAL' }),
    );
  });
});
