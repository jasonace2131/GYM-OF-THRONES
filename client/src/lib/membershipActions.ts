import { MembershipStatus } from '@got/shared';

/**
 * Which plan actions the member drawer offers, from the plan's stored status.
 *
 * The same rules as the server's transition table
 * (`server/src/membership/membership-transitions.ts`): FROZEN is reachable
 * only from ACTIVE, and CANCELLED from anything but CANCELLED. The drawer used
 * to show Freeze and Cancel whenever a plan existed, so a cancelled plan
 * offered two buttons that could only fail (owner bug report, 2026-11-07).
 * The server still decides; this only stops offering what it will refuse.
 */
export function membershipActions(status: MembershipStatus): { freeze: boolean; cancel: boolean } {
  return {
    freeze: status === MembershipStatus.ACTIVE,
    cancel: status !== MembershipStatus.CANCELLED,
  };
}
