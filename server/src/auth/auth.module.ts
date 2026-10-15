import { Module } from '@nestjs/common';
import { JwtVerifierService } from './jwt-verifier.service';
import { UserProvisioningService } from './user-provisioning.service';
import { AuthGuard } from './auth.guard';
import { SupabaseAdminService } from './supabase-admin.service';
import { LoginGateService } from './login-gate.service';
import { LoginCodeSettingSync } from './login-code/login-code-setting.sync';
import { LoginCodeController } from './login-code/login-code.controller';
import { LoginCodeService } from './login-code/login-code.service';

/**
 * AuthGuard is registered globally in AppModule via APP_GUARD, not here —
 * this module only supplies the pieces it depends on.
 *
 * `SupabaseAdminService` lives here (not in UsersModule) because it wraps
 * the Supabase Auth admin API — the same auth surface `JwtVerifierService`
 * and `UserProvisioningService` sit next to — even though its only caller
 * today is `MembersService`.
 *
 * `LoginGateService` is exported because the emailed sign-in code is enforced
 * in TWO guards — AuthGuard and CheckinModule's StationTokenAccessGuard — and
 * both must ask the same service. `LoginCodeSettingSync` (boot-time copy of
 * LOGIN_CODE_REQUIRED for the Realtime policy) injects `EmailService` from
 * the @Global NotificationsModule.
 *
 * It also owns the emailed sign-in code: `LoginCodeController` and the gate both guards call.
 */
@Module({
  controllers: [LoginCodeController],
  providers: [
    JwtVerifierService,
    UserProvisioningService,
    AuthGuard,
    SupabaseAdminService,
    LoginGateService,
    LoginCodeSettingSync,
    LoginCodeService,
  ],
  exports: [
    JwtVerifierService,
    UserProvisioningService,
    AuthGuard,
    SupabaseAdminService,
    LoginGateService,
  ],
})
export class AuthModule {}
