import { Module } from '@nestjs/common';
import { AdminLeadsController, ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * The seam left open in `app.module.ts` since chunk 0 — `// ContactModule`
 * sat commented out with a matching orphaned `CONTACT` route constant in
 * `@got/shared`. This fills it.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [ContactController, AdminLeadsController],
  providers: [ContactService],
  exports: [ContactService],
})
export class ContactModule {}
