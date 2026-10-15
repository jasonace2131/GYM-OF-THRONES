import { Global, Module } from '@nestjs/common';
import { ProofStorageService } from './proof-storage.service';
import { AnnouncementImageStorageService } from './announcement-image-storage.service';

/**
 * `@Global`, like `NotificationsModule` and `AuditModule`, and for the same
 * reason: the payments module signs uploads at the counter, the member's own
 * submission routes sign them from the portal, and the review queue signs
 * views. None of those modules has any other relationship with object storage.
 *
 * `AnnouncementImageStorageService` is the public announcements bucket — read
 * by the announcements service (uploads, URL validation) and by the nightly
 * orphan cleanup in the scheduler.
 */
@Global()
@Module({
  providers: [ProofStorageService, AnnouncementImageStorageService],
  exports: [ProofStorageService, AnnouncementImageStorageService],
})
export class StorageModule {}
