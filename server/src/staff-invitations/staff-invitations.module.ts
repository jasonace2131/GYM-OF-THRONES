import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StaffInvitationsController } from './staff-invitations.controller';
import { StaffInvitationsService } from './staff-invitations.service';

/**
 * Staff & Access: invitations. AuthModule for `SupabaseAdminService` (the
 * claim link); PrismaModule, AuditModule and NotificationsModule (the email)
 * are @Global.
 */
@Module({
  imports: [AuthModule],
  controllers: [StaffInvitationsController],
  providers: [StaffInvitationsService],
})
export class StaffInvitationsModule {}
