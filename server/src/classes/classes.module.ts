import { Module } from '@nestjs/common';
import { MembershipModule } from '../membership/membership.module';
import { AdminClassesController, ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';
import { BookingsService } from './bookings.service';

/**
 * PrismaModule, GymConfigModule and NotificationsModule (MemberNoticesService)
 * are @Global, so nothing needs importing for them.
 *
 * MembershipModule is imported for MembershipService.loadBookingSubject(s):
 * a member may book, and a waitlister may be promoted, only while their plan
 * covers the class day (owner, 2026-10-11). It imports nothing that reaches
 * back here, so there is no cycle.
 *
 * Exported because /me lists the member's own bookings and their booking
 * window, and the front desk asks for today's roster (route 51).
 */
@Module({
  imports: [MembershipModule],
  controllers: [ClassesController, AdminClassesController],
  providers: [ClassesService, BookingsService],
  exports: [ClassesService, BookingsService],
})
export class ClassesModule {}
