import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { GymConfigService } from '../config/gym.config';
import { PruneEphemeraJob } from './jobs/prune-ephemera.job';
import { AutoCloseVisitsJob } from './jobs/auto-close-visits.job';
import { MembershipNightlyJob } from '../membership/membership-nightly.job';
import { PruneAnnouncementImagesJob } from './jobs/prune-announcement-images.job';

/** One scheduled unit of work. Jobs own their schedule; the service owns the
 *  timezone and the registration. */
export interface ScheduledJob {
  readonly name: string;
  readonly cronExpression: string;
  run(): Promise<void>;
}

/**
 * Registers every job through SchedulerRegistry at bootstrap.
 *
 * Not static `@Cron` decorators: the schedule depends on GYM_TIMEZONE and
 * GYM_CLOSE_TIME, which are configuration, and a decorator argument cannot read
 * a provider. Registering imperatively is also what makes SCHEDULER_ENABLED a
 * real switch — a disabled instance registers nothing at all rather than
 * registering a job that checks a flag on every tick.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly gym: GymConfigService,
    private readonly pruneEphemera: PruneEphemeraJob,
    private readonly membershipNightly: MembershipNightlyJob,
    private readonly autoCloseVisits: AutoCloseVisitsJob,
    private readonly pruneAnnouncementImages: PruneAnnouncementImagesJob,
  ) {}

  onModuleInit(): void {
    if (!this.gym.schedulerEnabled) {
      this.logger.warn('SCHEDULER_ENABLED=false — no jobs registered on this instance');
      return;
    }
    this.register(this.pruneEphemera);
    // One registry, one timezone, one switch. A second scheduler would be a
    // second place SCHEDULER_ENABLED has to be honoured.
    this.register(this.membershipNightly);
    // Closes visits still open after closing time — the only writer of
    // AUTO_CLOSE, and the only way a walk-in guest's visit ever ends if the
    // desk forgets to check them out.
    this.register(this.autoCloseVisits);
    // Announcement images nothing references once they are a day old —
    // abandoned uploads, images edited out, and those of deleted notices.
    this.register(this.pruneAnnouncementImages);
  }

  register(job: ScheduledJob): void {
    const cronJob = new CronJob(
      job.cronExpression,
      () => {
        void this.fire(job);
      },
      null,
      false,
      this.gym.timeZone,
    );

    this.registry.addCronJob(job.name, cronJob);
    cronJob.start();

    this.logger.log(
      `registered job=${job.name} cron="${job.cronExpression}" tz=${this.gym.timeZone}`,
    );
  }

  /**
   * The job itself raises; this boundary logs. Letting a rejection escape the
   * tick callback would surface as an unhandled rejection and, on Node's
   * default, take the process down — turning a failed purge into an outage.
   */
  private async fire(job: ScheduledJob): Promise<void> {
    try {
      await job.run();
    } catch (error) {
      this.logger.error(
        `job=${job.name} failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
