import { SchedulerRegistry } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import type { GymConfigService } from '../config/gym.config';
import type { PruneEphemeraJob } from './jobs/prune-ephemera.job';
import type { MembershipNightlyJob } from '../membership/membership-nightly.job';
import type { AutoCloseVisitsJob } from './jobs/auto-close-visits.job';
import type { PruneAnnouncementImagesJob } from './jobs/prune-announcement-images.job';
import type { EraseDeletedAuthJob } from './jobs/erase-deleted-auth.job';

function fakeJob(run: jest.Mock = jest.fn().mockResolvedValue(undefined)): PruneEphemeraJob {
  return {
    name: 'pruneEphemera',
    cronExpression: '30 03 * * *',
    run,
  } as unknown as PruneEphemeraJob;
}

function fakeNightly(
  run: jest.Mock = jest.fn().mockResolvedValue(undefined),
): MembershipNightlyJob {
  return {
    name: 'membershipNightly',
    cronExpression: '15 3 * * *',
    run,
  } as unknown as MembershipNightlyJob;
}

function fakeAutoClose(
  run: jest.Mock = jest.fn().mockResolvedValue(undefined),
): AutoCloseVisitsJob {
  return {
    name: 'autoCloseVisits',
    cronExpression: '*/15 * * * *',
    run,
  } as unknown as AutoCloseVisitsJob;
}

function fakePruneImages(
  run: jest.Mock = jest.fn().mockResolvedValue(undefined),
): PruneAnnouncementImagesJob {
  return {
    name: 'pruneAnnouncementImages',
    cronExpression: '45 03 * * *',
    run,
  } as unknown as PruneAnnouncementImagesJob;
}

function fakeEraseAuth(
  run: jest.Mock = jest.fn().mockResolvedValue(undefined),
): EraseDeletedAuthJob {
  return {
    name: 'eraseDeletedAuth',
    cronExpression: '*/30 * * * *',
    run,
  } as unknown as EraseDeletedAuthJob;
}

function gymConfig(overrides: Partial<GymConfigService> = {}): GymConfigService {
  return {
    timeZone: 'Asia/Manila',
    schedulerEnabled: true,
    ...overrides,
  } as unknown as GymConfigService;
}

describe('SchedulerService', () => {
  let registry: SchedulerRegistry;

  beforeEach(() => {
    registry = new SchedulerRegistry();
  });

  afterEach(() => {
    // Every registered CronJob holds a live timer. Leaving one running makes
    // jest hang with an open handle after the suite reports green.
    registry.getCronJobs().forEach((job) => void job.stop());
  });

  it('registers every job with the gym timezone pinned', () => {
    const service = new SchedulerService(
      registry,
      gymConfig(),
      fakeJob(),
      fakeNightly(),
      fakeAutoClose(),
      fakePruneImages(),
      fakeEraseAuth(),
    );

    service.onModuleInit();

    expect(registry.getCronJobs().size).toBe(5);
    for (const name of [
      'pruneEphemera',
      'membershipNightly',
      'autoCloseVisits',
      'pruneAnnouncementImages',
      'eraseDeletedAuth',
    ]) {
      const job = registry.getCronJob(name);
      expect(job).toBeDefined();
      expect((job.cronTime as unknown as { timeZone?: string }).timeZone).toBe('Asia/Manila');
    }
  });

  it('honours a non-default timezone', () => {
    const service = new SchedulerService(
      registry,
      gymConfig({ timeZone: 'Asia/Calcutta' }),
      fakeJob(),
      fakeNightly(),
      fakeAutoClose(),
      fakePruneImages(),
      fakeEraseAuth(),
    );

    service.onModuleInit();

    expect(
      (registry.getCronJob('membershipNightly').cronTime as unknown as { timeZone?: string })
        .timeZone,
    ).toBe('Asia/Calcutta');
  });

  it('registers zero jobs when SCHEDULER_ENABLED is false', () => {
    const service = new SchedulerService(
      registry,
      gymConfig({ schedulerEnabled: false }),
      fakeJob(),
      fakeNightly(),
      fakeAutoClose(),
      fakePruneImages(),
      fakeEraseAuth(),
    );

    service.onModuleInit();

    expect(registry.getCronJobs().size).toBe(0);
  });

  it('logs and does not rethrow when a job raises, so one failure cannot kill the process', async () => {
    const run = jest.fn().mockRejectedValue(new Error('nightly exploded'));
    const service = new SchedulerService(
      registry,
      gymConfig(),
      fakeJob(),
      fakeNightly(run),
      fakeAutoClose(),
      fakePruneImages(),
      fakeEraseAuth(),
    );
    const error = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    service.onModuleInit();
    await registry.getCronJob('membershipNightly').fireOnTick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('membershipNightly');
  });
});
