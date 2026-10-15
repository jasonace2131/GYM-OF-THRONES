import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AnnouncementImageStorageService,
  type StoredAnnouncementImage,
} from '../../storage/announcement-image-storage.service';
import {
  announcementImageKey,
  collectAnnouncementImageUrls,
} from '../../announcements/rich-content';
import type { ScheduledJob } from '../scheduler.service';

const MS_PER_HOUR = 3_600_000;

/**
 * How old an unreferenced image must be before it goes. A day is long past
 * any composing session: the admin uploads, the image sits in their draft, and
 * nothing references it until they press Post.
 */
const ORPHAN_AFTER_HOURS = 24;

/** Objects strictly older than `cutoff` that no notice references. */
export function orphanedImageKeys(
  objects: readonly StoredAnnouncementImage[],
  referenced: ReadonlySet<string>,
  cutoff: Date,
): string[] {
  return objects
    .filter((object) => object.createdAt.getTime() < cutoff.getTime())
    .filter((object) => !referenced.has(object.key))
    .map((object) => object.key);
}

/**
 * Deletes announcement images nothing uses any more.
 *
 * Three ways an image becomes an orphan, and this one job covers all of them:
 * an upload that was never posted (the admin closed the composer), an image
 * removed from a notice by an edit, and every image of a deleted notice.
 * Deleting at edit or delete time would cover only the last two and would put
 * a storage call inside a write that should not be able to fail on one.
 *
 * ORDER IS THE SAFETY ARGUMENT. The bucket is listed FIRST and the references
 * read SECOND, so a notice saved while the job runs is already in the
 * reference set by the time anything is chosen for deletion. And nothing
 * under a day old is ever a candidate, which is what keeps an image sitting in
 * an unsaved draft alive.
 *
 * Idempotent: a second run finds only what the first could not remove.
 */
@Injectable()
export class PruneAnnouncementImagesJob implements ScheduledJob {
  readonly name = 'pruneAnnouncementImages';
  readonly cronExpression = '45 03 * * *';

  private readonly logger = new Logger(PruneAnnouncementImagesJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly images: AnnouncementImageStorageService,
  ) {}

  async run(): Promise<void> {
    if (!this.images.enabled) {
      this.logger.log(`job=${this.name} skipped: announcement images are disabled`);
      return;
    }

    const cutoff = new Date(Date.now() - ORPHAN_AFTER_HOURS * MS_PER_HOUR);

    // No try/catch: a failed listing raises to the scheduler, which logs it.
    const objects = await this.images.listObjects();
    if (!objects.some((object) => object.createdAt.getTime() < cutoff.getTime())) {
      this.logger.log(
        `job=${this.name} cutoff=${cutoff.toISOString()} objects=${objects.length} removed=0`,
      );
      return;
    }

    // The whole board: one gym's notices, a few hundred rows at most.
    const rows = await this.prisma.announcement.findMany({
      select: { contentJson: true, coverImageUrl: true },
    });

    const referenced = new Set<string>();
    const base = this.images.publicBaseUrl;
    for (const row of rows) {
      const urls = collectAnnouncementImageUrls(row.contentJson);
      if (row.coverImageUrl !== null) urls.push(row.coverImageUrl);
      for (const url of urls) {
        const key = announcementImageKey(url, base);
        if (key !== null) referenced.add(key);
      }
    }

    const orphans = orphanedImageKeys(objects, referenced, cutoff);
    const removed = orphans.length === 0 ? 0 : await this.images.remove(orphans);

    this.logger.log(
      `job=${this.name} cutoff=${cutoff.toISOString()} objects=${objects.length} ` +
        `referenced=${referenced.size} orphans=${orphans.length} removed=${removed}`,
    );
  }
}
