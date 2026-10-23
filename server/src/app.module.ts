import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule, type ThrottlerModuleOptions } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RbacModule } from './rbac/rbac.module';
import { CoachAssignmentsModule } from './coach-assignments/coach-assignments.module';
import { CatalogueModule } from './catalogue/catalogue.module';
import { PaymentsModule } from './payments/payments.module';
import { MembershipModule } from './membership/membership.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { AssistantModule } from './assistant/assistant.module';
import { ClassesModule } from './classes/classes.module';
import { ConsentModule } from './consent/consent.module';
import { ContactModule } from './contact/contact.module';
import { MeModule } from './me/me.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AuditModule } from './audit/audit.module';
import { StorageModule } from './storage/storage.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { CheckinModule } from './checkin/checkin.module';
import { FrontDeskModule } from './front-desk/front-desk.module';
import { AdminModule } from './admin/admin.module';
import { ChatModule } from './chat/chat.module';
import { WorkoutPlansModule } from './workout-plans/workout-plans.module';
import { WorkoutsModule } from './workouts/workouts.module';
import { GymEquipmentModule } from './gym-equipment/gym-equipment.module';
// ── Staff & Access ──
import { StaffInvitationsModule } from './staff-invitations/staff-invitations.module';
import { CoachesModule } from './coaches/coaches.module';
// ── end Staff & Access ──
import { AuthGuard } from './auth/auth.guard';
import { PermissionsGuard } from './rbac/permissions.guard';
import { ActiveMembershipGuard } from './membership/active-membership.guard';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { envValidationSchema, type Env } from './config/env.validation';
import { ipInAnyCidr, parseCidrList } from './checkin/origin';
import { GymConfigModule } from './config/gym-config.module';

/**
 * Root application module.
 *
 * Only application-wide concerns belong here:
 * - ConfigModule (environment variables)
 * - ThrottlerModule (rate limiting)
 * - Global infrastructure modules (Prisma, Health)
 *
 * Feature modules (Auth, Users, Announcements, etc.) are imported here
 * as they are built, one module at a time.
 */
@Module({
  imports: [
    // Environment variable configuration — available globally
    ConfigModule.forRoot({
      isGlobal: true,
      validate: envValidationSchema,
      envFilePath: ['.env.local', '.env'],
    }),

    // Rate limiting — TWO named buckets, and they answer different questions.
    //
    // `default` is keyed on the AUTHENTICATED USER by UserThrottlerGuard
    // (falling back to IP on @Public() routes, and to the station key on the
    // display's routes). It bounds one account's retries.
    //
    // `origin` is keyed on the SOURCE IP and exempts the gym's own egress. It
    // exists for exactly one threat the per-user bucket cannot see: a relay is
    // N accounts submitting ONCE each, which never trips a per-member limit,
    // and its consumers sit behind a consumer address pool. The exemption is
    // what keeps the 06:00 peak on gym wifi out of its way — forty people
    // arriving in ten minutes is the case the gym most needs to work.
    //
    // The module-level `origin` ceiling is a loose backstop; POST /checkin
    // tightens it to 60/60s with @Throttle. Tightening per route rather than
    // globally is deliberate: a 60/min per-IP cap applied to every endpoint
    // would throttle the front desk's own console off the gym's single
    // address.
    //
    // NOTE: in-memory storage, so every limit is per instance. Running more
    // than one instance multiplies the effective limit — swap in a shared
    // store before scaling horizontally.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): ThrottlerModuleOptions => {
        const gymEgress = parseCidrList(config.get('GYM_EGRESS_CIDRS'));
        return {
          throttlers: [
            { name: 'default', ttl: 60_000, limit: 100 },
            {
              name: 'origin',
              ttl: 60_000,
              limit: 600,
              getTracker: (req: Record<string, unknown>): string =>
                `origin:${typeof req['ip'] === 'string' ? req['ip'] : 'unknown'}`,
              // An empty GYM_EGRESS_CIDRS parses to an empty list, so nothing
              // is exempt and the bucket simply applies — which is the safe
              // direction for a limit that is generous by design.
              skipIf: (context): boolean =>
                ipInAnyCidr(context.switchToHttp().getRequest<{ ip?: string }>().ip, gymEgress),
            },
          ],
        };
      },
    }),

    // Infrastructure
    PrismaModule,
    GymConfigModule,
    HealthModule,
    // Provides SchedulerRegistry. Jobs are registered imperatively by
    // SchedulerService, so this call takes no options.
    ScheduleModule.forRoot(),

    // Feature modules — added per phase
    AuthModule,
    UsersModule,
    RbacModule,
    CoachAssignmentsModule,
    CatalogueModule,
    PaymentsModule,
    MembershipModule,
    MeModule,
    SchedulerModule,
    CheckinModule,
    FrontDeskModule,
    AdminModule,
    // ── Staff & Access ──
    StaffInvitationsModule,
    CoachesModule,
    // ── end Staff & Access ──
    // @Global, so its SystemNotificationsService reaches the producers
    // scattered across other feature modules without each importing it.
    // Listed here explicitly rather than inherited through ContactModule and
    // UsersModule so the notification CONTROLLER's registration is visible.
    NotificationsModule,
    // @Global, like NotificationsModule and for the same reason: its producers
    // are spread across payments, front desk, users, catalogue and config.
    AuditModule,
    // @Global too: the counter signs proof uploads, the portal signs them, and
    // the review queue signs views. None of those owns object storage.
    StorageModule,
    AnnouncementsModule,
    AssistantModule,
    // The gym's equipment list (Admin → Settings), read by the AI planners.
    GymEquipmentModule,
    ClassesModule,
    ConsentModule,
    ContactModule,
    // ── Coach tools (feat/coach-tools) ──
    ChatModule,
    WorkoutPlansModule,
    // ── Member workout planner (feat/member-workouts) ──
    WorkoutsModule,
    // ServicesModule,
  ],
  providers: [
    // Global guards run in provider-array order. The order below is the whole
    // point: AuthGuard attaches request.user, so UserThrottlerGuard can key on
    // it, and a throttled request never reaches the permission cache.
    // Authentication runs on every route. Opt out per-endpoint with @Public().
    // Protected-by-default is the safer direction to forget in.
    { provide: APP_GUARD, useClass: AuthGuard },
    // Rate limiting, keyed on the authenticated user rather than the IP.
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    // Runs after AuthGuard. Only enforces on routes carrying @RequirePermission().
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Runs after PermissionsGuard. Only enforces on routes carrying
    // @RequireActiveMembership(), and only for a member (CLIENT): the
    // member-only features need an ACTIVE membership (owner, 2026-10-17).
    { provide: APP_GUARD, useClass: ActiveMembershipGuard },
    // Outermost interceptor: it observes the finished response body and
    // replays it verbatim, so a replay carries exactly one envelope. Does
    // nothing at all to a route without @Idempotent().
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
