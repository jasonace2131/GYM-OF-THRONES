import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { MemberJoinController } from './member-join.controller';
import { MemberJoinService } from './member-join.service';
import { RbacModule } from '../rbac/rbac.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MembershipModule } from '../membership/membership.module';

/**
 * `UsersController` owns `GET /me` — the caller's own profile, keyless.
 * `MembersController` owns the CRM's roster, behind `member.read` and scoped.
 * They are separate controllers because they answer to different permissions
 * and different audiences, not because the routes happen to differ.
 *
 * AuthModule, NotificationsModule and MembershipModule are C2's additions:
 * `MembersService.create` mints the member's Supabase user (`createAuthUser`
 * on `SupabaseAdminService`), can optionally record a sale
 * (`MembershipSalesService`) in the same call, and has `MemberJoinService` issue
 * and email the setup link (`EmailService`). `MembershipModule` does not import
 * `UsersModule`, so this is not a cycle.
 *
 * `MemberJoinController`/`MemberJoinService` own a staff-created member's own
 * 7-day setup link (`/join/<token>`); the service is exported because member
 * creation, "Resend invite" and an email correction all issue one.
 */
@Module({
  imports: [RbacModule, AuthModule, NotificationsModule, MembershipModule],
  controllers: [UsersController, MembersController, MemberJoinController],
  providers: [MembersService, MemberJoinService],
  exports: [MembersService, MemberJoinService],
})
export class UsersModule {}
