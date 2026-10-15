import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { MeNoticesController } from './me-notices.controller';
import { MemberNoticesService } from './member-notices.service';
import { NotificationsController } from './notifications.controller';
import { SystemNotificationsService } from './system-notifications.service';

/**
 * Email, the in-console notification board, and members' own notices.
 *
 * `@Global` for the two producer-facing services specifically. Their producers
 * are scattered across feature modules that have nothing else to do with
 * notifications — the contact form and the nightly membership job raise
 * `SystemNotificationsService` notices; `ClassesService` and `BookingsService`
 * send `MemberNoticesService` ones when a waitlist place turns into a seat or
 * a class is cancelled, moved, or booked or emptied by the desk — and making
 * each of those import this module would put a notification dependency in the
 * import list of half the application. The pattern `GymConfigModule` already
 * uses, for the same reason.
 *
 * The two boards stay separate on purpose. A system notification's read state
 * is shared by the staff who work the console; a member notice has exactly one
 * recipient, its own `readAt`, and is reached only through that member's
 * keyless `/me/notices` routes.
 */
@Global()
@Module({
  controllers: [NotificationsController, MeNoticesController],
  providers: [EmailService, SystemNotificationsService, MemberNoticesService],
  exports: [EmailService, SystemNotificationsService, MemberNoticesService],
})
export class NotificationsModule {}
