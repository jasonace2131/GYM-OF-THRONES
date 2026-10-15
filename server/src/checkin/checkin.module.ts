import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { MembershipModule } from '../membership/membership.module';
import { CheckInController, CheckInStatusController } from './check-in.controller';
import { CheckInService } from './check-in.service';
import { DeskFeedService } from './desk-feed.service';
import { StationTokensController } from './station-tokens.controller';
import { StationTokensService } from './station-tokens.service';
import { StationTokenService } from './station-token.service';
import { StationTokenAccessGuard } from './station.guard';
import { MemberCodeService } from './member-code.service';
import { MemberCodeIssuer } from './member-code.issuer';
import {
  CheckInDenialsReportController,
  CheckInsReportController,
} from './check-ins-report.controller';
import { CheckInsReportService } from './check-ins-report.service';

/**
 * Chunk 2: station QR attendance — the station-token surface (issuing,
 * rotation, verification) and the check-in write path built on top of it. The
 * front-desk console's own controllers land in a later slice against the same
 * `CheckInService`, which is why the record-shaped logic lives in the service
 * rather than in `CheckInController`.
 *
 * `AuthModule` and `RbacModule` are imported because `StationTokenAccessGuard`
 * performs its staff-fallback authentication and permission check BY HAND
 * (§6.2.1's auth line is an OR the global `AuthGuard` → `PermissionsGuard`
 * pipeline cannot express), so it needs `JwtVerifierService`,
 * `UserProvisioningService` and `PermissionsService` directly rather than
 * relying on the request already having been through those guards.
 *
 * `MembershipModule` is imported for `MembershipService` — the write path
 * re-runs the door ladder INSIDE its transaction, which means loading the
 * subject through the same service every other surface uses rather than
 * growing a second, quietly divergent copy of that read. The dependency runs
 * one way only: nothing in `MembershipModule` imports this module, and the
 * `DAY_PASS_RESOLVER` seam is what keeps it that way.
 */
@Module({
  imports: [AuthModule, RbacModule, MembershipModule],
  controllers: [
    StationTokensController,
    CheckInController,
    CheckInStatusController,
    CheckInsReportController,
    CheckInDenialsReportController,
  ],
  providers: [
    StationTokenService,
    StationTokensService,
    StationTokenAccessGuard,
    CheckInService,
    DeskFeedService,
    MemberCodeService,
    MemberCodeIssuer,
    CheckInsReportService,
  ],
  exports: [
    StationTokenService,
    StationTokensService,
    CheckInService,
    DeskFeedService,
    // Exported for /me (the member mints their own) and the front desk (staff
    // scan it) — the two ends of the fallback path.
    MemberCodeService,
    MemberCodeIssuer,
  ],
})
export class CheckinModule {}
