import { PruneEphemeraJob } from './prune-ephemera.job';
import type { PrismaService } from '../../prisma/prisma.service';
import type { GymConfigService } from '../../config/gym.config';

/**
 * A minimal in-memory fake of the two `idempotencyRecord` calls the job
 * makes, filtering on the actual predicates rather than just recording call
 * args — so the "stuck claims survive" test exercises real filtering logic,
 * not just an assertion that a particular object literal was passed.
 */
function fakeIdempotencyStore(rows: { key: string; createdAt: Date; responseStatus: number }[]) {
  return {
    count: jest.fn(({ where }: { where: { createdAt: { lt: Date }; responseStatus: number } }) =>
      Promise.resolve(
        rows.filter(
          (r) => r.createdAt < where.createdAt.lt && r.responseStatus === where.responseStatus,
        ).length,
      ),
    ),
    deleteMany: jest.fn(
      ({ where }: { where: { createdAt: { lt: Date }; responseStatus: { not: number } } }) => {
        const survivors = rows.filter(
          (r) =>
            !(r.createdAt < where.createdAt.lt && r.responseStatus !== where.responseStatus.not),
        );
        const deletedCount = rows.length - survivors.length;
        rows.splice(0, rows.length, ...survivors);
        return Promise.resolve({ count: deletedCount });
      },
    ),
  };
}

describe('PruneEphemeraJob', () => {
  const deleteMany = jest.fn();
  const count = jest.fn();
  const scanDeleteMany = jest.fn();
  const prisma = {
    idempotencyRecord: { deleteMany, count },
    stationScan: { deleteMany: scanDeleteMany },
  } as unknown as PrismaService;
  const gym = { idempotencyRetentionHours: 24 } as unknown as GymConfigService;

  beforeEach(() => {
    deleteMany.mockReset();
    count.mockReset();
    scanDeleteMany.mockReset();
    deleteMany.mockResolvedValue({ count: 0 });
    count.mockResolvedValue(0);
    scanDeleteMany.mockResolvedValue({ count: 0 });
    jest.useFakeTimers().setSystemTime(new Date('2026-08-18T19:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('identifies itself with the fixed schedule', () => {
    const job = new PruneEphemeraJob(prisma, gym);
    expect(job.name).toBe('pruneEphemera');
    expect(job.cronExpression).toBe('30 03 * * *');
  });

  it('computes the cutoff from IDEMPOTENCY_RETENTION_HOURS, excluding stuck claims from deletion', async () => {
    deleteMany.mockResolvedValue({ count: 7 });
    const job = new PruneEphemeraJob(prisma, gym);

    await job.run();

    const cutoff = new Date('2026-08-17T19:30:00.000Z');
    expect(deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff }, responseStatus: { not: 0 } },
    });
    expect(count).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff }, responseStatus: 0 },
    });
  });

  it('honours a different retention window', async () => {
    deleteMany.mockResolvedValue({ count: 0 });
    const job = new PruneEphemeraJob(prisma, {
      idempotencyRetentionHours: 1,
    } as unknown as GymConfigService);

    await job.run();

    const cutoff = new Date('2026-08-18T18:30:00.000Z');
    expect(deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff }, responseStatus: { not: 0 } },
    });
    expect(count).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff }, responseStatus: 0 },
    });
  });

  it('logs one structured line carrying deleted and skipped counts separately', async () => {
    deleteMany.mockResolvedValue({ count: 41 });
    count.mockResolvedValue(3);
    const job = new PruneEphemeraJob(prisma, gym);
    const log = jest.spyOn(job['logger'], 'log').mockImplementation(() => undefined);

    await job.run();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('IdempotencyRecord.deleted=41');
    expect(log.mock.calls[0][0]).toContain('IdempotencyRecord.skipped=3');
    // Both tables are named, because a single `deleted=` count that silently
    // covered two tables is how the StationScan half went missing unnoticed.
    expect(log.mock.calls[0][0]).toContain('StationScan.deleted=');
  });

  /**
   * THE REGRESSION TEST FOR THE HALF THAT NEVER SHIPPED.
   *
   * `station-scan.prisma` documented a 24h retention window and the chunk-2
   * design listed this job as enforcing it. Only the IdempotencyRecord half
   * was written, so the table carrying `originIpHash` — a per-member
   * behavioural record, and the one thing in this schema explicitly annotated
   * as Data Privacy Act-relevant — grew without bound.
   */
  it('prunes StationScan on the same cutoff, by consumedAt', async () => {
    scanDeleteMany.mockResolvedValue({ count: 12 });
    const job = new PruneEphemeraJob(prisma, gym);

    await job.run();

    expect(scanDeleteMany).toHaveBeenCalledWith({
      where: { consumedAt: { lt: new Date('2026-08-17T19:30:00.000Z') } },
    });
  });

  it('raises rather than swallowing a database failure', async () => {
    deleteMany.mockRejectedValue(new Error('connection terminated'));
    const job = new PruneEphemeraJob(prisma, gym);

    await expect(job.run()).rejects.toThrow('connection terminated');
  });

  it('leaves a stuck claim (responseStatus: 0) in place while deleting an ordinary expired claim next to it', async () => {
    const rows = [
      { key: 'stuck-claim', createdAt: new Date('2026-08-01T00:00:00.000Z'), responseStatus: 0 },
      {
        key: 'ordinary-expired-claim',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        responseStatus: 200,
      },
    ];
    const store = fakeIdempotencyStore(rows);
    const localPrisma = {
      idempotencyRecord: store,
      stationScan: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaService;
    const job = new PruneEphemeraJob(localPrisma, gym);

    await job.run();

    expect(rows.map((r) => r.key)).toEqual(['stuck-claim']);
  });
});
