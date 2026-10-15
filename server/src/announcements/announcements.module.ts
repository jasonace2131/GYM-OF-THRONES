import { Module } from '@nestjs/common';
import { AdminAnnouncementsController, AnnouncementsController } from './announcements.controller';
import { AnnouncementsService } from './announcements.service';
import { MeAnnouncementsController } from './me-announcements.controller';
import { MemberAnnouncementsService } from './member-announcements.service';

/**
 * PrismaModule is @Global, so nothing needs importing here. RbacModule is not
 * imported either: PermissionsGuard is registered once as an APP_GUARD in
 * AppModule and resolves from the root injector.
 *
 * `MeAnnouncementsController` owns `/me/announcements`. Nest resolves it beside
 * the `@Controller('me')` classes elsewhere without collision, because each
 * owns distinct sub-paths.
 */
@Module({
  controllers: [AnnouncementsController, AdminAnnouncementsController, MeAnnouncementsController],
  providers: [AnnouncementsService, MemberAnnouncementsService],
})
export class AnnouncementsModule {}
