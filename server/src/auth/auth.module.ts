import { Module } from '@nestjs/common';
import { JwtVerifierService } from './jwt-verifier.service';
import { UserProvisioningService } from './user-provisioning.service';
import { AuthGuard } from './auth.guard';
import { SupabaseAdminService } from './supabase-admin.service';

/**
 * AuthGuard is registered globally in AppModule via APP_GUARD, not here —
 * this module only supplies the pieces it depends on.
 *
 * `SupabaseAdminService` lives here (not in UsersModule) because it wraps
 * the Supabase Auth admin API — the same auth surface `JwtVerifierService`
 * and `UserProvisioningService` sit next to — even though its only caller
 * today is `MembersService`.
 */
@Module({
  providers: [JwtVerifierService, UserProvisioningService, AuthGuard, SupabaseAdminService],
  exports: [JwtVerifierService, UserProvisioningService, AuthGuard, SupabaseAdminService],
})
export class AuthModule {}
