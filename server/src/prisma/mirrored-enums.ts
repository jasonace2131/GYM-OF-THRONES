import {
  AccessVerdict as PrismaAccessVerdict,
  CheckInMethod as PrismaCheckInMethod,
  DenialReason as PrismaDenialReason,
  DiscountType as PrismaDiscountType,
  MembershipStatus as PrismaMembershipStatus,
  PaymentMethod as PrismaPaymentMethod,
  PaymentPurpose as PrismaPaymentPurpose,
  PaymentStatus as PrismaPaymentStatus,
  PlanKind as PrismaPlanKind,
  Role,
  UserStatus as PrismaUserStatus,
} from '@prisma/client';
import {
  AccessVerdict,
  CheckInMethod,
  DenialReason,
  DiscountType,
  MembershipStatus,
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
  PlanKind,
  UserRole,
  UserStatus,
} from '@got/shared';

/**
 * The parity table enum-parity.spec.ts drives itself off.
 *
 * `name` is the export name in @got/shared, so the spec's meta-test can prove
 * that every enum the shared package exports is accounted for in exactly one of
 * the two lists below. Adding an enum to @got/shared and forgetting both lists
 * is a failing test, not a silent omission.
 *
 * Enums that are internal to the server — MembershipEventType, HoldStatus,
 * DenialOutcome, CoachAssignmentStatus, CheckOutMethod, CheckInEntryType,
 * StationScanOutcome — stay Prisma-side and appear in neither list, because
 * they are never mirrored and the client never switches on them.
 */
export interface MirroredEnumPair {
  name: string;
  prisma: Record<string, string>;
  shared: Record<string, string>;
}

export const MIRRORED_ENUM_PAIRS: readonly MirroredEnumPair[] = [
  { name: 'UserRole', prisma: Role, shared: UserRole },
  { name: 'UserStatus', prisma: PrismaUserStatus, shared: UserStatus },
  { name: 'MembershipStatus', prisma: PrismaMembershipStatus, shared: MembershipStatus },
  { name: 'PlanKind', prisma: PrismaPlanKind, shared: PlanKind },
  { name: 'PaymentPurpose', prisma: PrismaPaymentPurpose, shared: PaymentPurpose },
  { name: 'PaymentMethod', prisma: PrismaPaymentMethod, shared: PaymentMethod },
  { name: 'PaymentStatus', prisma: PrismaPaymentStatus, shared: PaymentStatus },
  { name: 'DiscountType', prisma: PrismaDiscountType, shared: DiscountType },
  { name: 'DenialReason', prisma: PrismaDenialReason, shared: DenialReason },
  { name: 'AccessVerdict', prisma: PrismaAccessVerdict, shared: AccessVerdict },
  { name: 'CheckInMethod', prisma: PrismaCheckInMethod, shared: CheckInMethod },
];

/**
 * Mirrored into @got/shared now, Prisma side lands later.
 *
 * A chunk-1 or chunk-2 author who adds `enum MembershipStatus` to
 * enums.prisma without moving its entry from here into MIRRORED_ENUM_PAIRS
 * gets a failing meta-test — which is the whole point of the allowlist.
 *
 * Empty as of this commit: CheckInMethod landed in enums.prisma and moved up
 * into MIRRORED_ENUM_PAIRS above.
 */
export const PENDING_PRISMA_MIRRORS: readonly { name: string; landsInChunk: 1 | 2 }[] = [];

// Referenced so the imports above are load-bearing rather than decorative:
// if an enum is removed from @got/shared this file stops compiling, which is a
// louder failure than a spec that silently has one fewer case.
const MIRRORED_SHARED_ENUMS = {
  MembershipStatus,
  PlanKind,
  PaymentPurpose,
  PaymentMethod,
  PaymentStatus,
  DiscountType,
  CheckInMethod,
  DenialReason,
  AccessVerdict,
} as const;

export type PendingMirrorName = keyof typeof MIRRORED_SHARED_ENUMS;

/**
 * Prisma enums that are deliberately NOT mirrored into @got/shared, with the
 * reason. Listed so a later author reads "decided" rather than "forgotten".
 *
 * CoachAssignmentStatus: no client screen switches on it — a client reads
 * `endedAt === null`. Mirroring it would add a drift surface for nothing.
 */
export const SERVER_ONLY_PRISMA_ENUMS: readonly string[] = [
  'CoachAssignmentStatus',
  // Chunk 2 — no client screen switches on any of these directly; the desk
  // and the member's phone switch on DenialReason / CheckInResult.outcome.
  'CheckOutMethod',
  'CheckInEntryType',
  'StationScanOutcome',
  'DenialOutcome',
];
