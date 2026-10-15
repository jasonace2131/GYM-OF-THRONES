// User domain types shared between client and server.
//
// UserRole and UserStatus are mirrored by the Prisma enums in
// server/prisma/schema/enums.prisma. Prisma cannot import from here, so the
// two definitions are kept in sync by hand and enum-parity.spec.ts asserts
// they agree — if you change one, change the other.

export enum UserRole {
  /**
   * Any non-staff account holder, whether or not they pay for a membership.
   * Anyone can register for free. Membership is separate state with its own
   * dates and lifecycle — it is never a role, because roles describe what
   * kind of person you are in the organisation and change rarely, while a
   * membership lapses, freezes and renews.
   */
  CLIENT = 'CLIENT',
  /** Shared counter device: check-ins and client lookup only. */
  FRONT_DESK = 'FRONT_DESK',
  COACH = 'COACH',
  ADMIN = 'ADMIN',
  /** Superuser escape hatch. Assignable only by seed or direct DB access. */
  DEV = 'DEV',
}

/**
 * Whether the account may be used at all. Nothing to do with payment —
 * someone with no membership still has an ACTIVE account.
 */
export enum UserStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  DEACTIVATED = 'DEACTIVATED',
}

export interface User {
  id: string;
  supabaseId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  /** Metric. Optional — an account is valid without body metrics. */
  heightCm: number | null;
  /** Metric. Current reading; history lives in its own table when built. */
  weightKg: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The safe-to-expose projection of a user.
 *
 * Body metrics are deliberately absent: height and weight are personal health
 * data and have no business appearing anywhere a user is listed to others.
 */
export type PublicUser = Pick<User, 'id' | 'firstName' | 'lastName' | 'avatarUrl' | 'role'>;
