import { SetMetadata } from '@nestjs/common';

export const REQUIRE_ACTIVE_MEMBERSHIP_KEY = 'requireActiveMembership';

/**
 * This route needs an ACTIVE membership when a member (CLIENT) calls it —
 * `ActiveMembershipGuard` answers 403 MEMBERSHIP_REQUIRED otherwise. Staff are
 * never asked (membership-gate.ts).
 *
 * Put it on the routes that spend AI quota or write to a member-only feature,
 * never on a read: an expired member keeps their history (owner, 2026-10-17).
 */
export const RequireActiveMembership = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_ACTIVE_MEMBERSHIP_KEY, true);
