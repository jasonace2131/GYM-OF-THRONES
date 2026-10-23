import { NAME_MAX } from '../validation/inputs';

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

/**
 * The caller's own editable profile — `GET`/`PATCH /me/profile`.
 *
 * Separate from `GET /me` on purpose: `/me` is fetched by every portal screen
 * and refreshed on focus, and `medicalNotes` is sensitive personal information
 * (RA 10173 §3(l)) that only the account page needs. `email` is read-only
 * here — it changes through Supabase's confirmed email change, and the API
 * copies it from the verified token on the next request.
 */
export interface MyProfile {
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  /** The check-in lookup handle; null until the first membership or day pass. */
  memberCode: string | null;
  heightCm: number | null;
  weightKg: number | null;
  medicalNotes: string | null;
  /** The member's opt-in: medical notes reach the AI planner only when true. */
  shareMedicalWithPlanner: boolean;
  /** The account page's badge and tile. Null when there is no plan on file. */
  membership: MyProfileMembership | null;
  /**
   * Whether `POST /me/delete-account` is open to this caller — a member
   * (CLIENT) account only. Staff accounts are closed by an admin, not here.
   */
  canDeleteAccount: boolean;
}

export interface MyProfileMembership {
  planName: string;
  /** `ACTIVE | EXPIRED | FROZEN | CANCELLED`. */
  status: string;
  /** Civil date, `yyyy-mm-dd`. */
  endsOn: string;
  /** Whole days from the gym's today to `endsOn`, never below 0. */
  daysLeft: number;
}

/** The `PATCH /me/profile` body. Every field optional; `null` clears it. */
export interface MyProfilePatch {
  /** 1–60 characters after the trim; letters, spaces and ' - . only. Not clearable. */
  firstName?: string;
  lastName?: string;
  /** `null` or blank clears it. */
  phone?: string | null;
  heightCm?: number | null;
  weightKg?: number | null;
  medicalNotes?: string | null;
  shareMedicalWithPlanner?: boolean;
}

/** `POST /me/delete-account` — the member's own, instant, anonymising delete. */
export interface DeleteMyAccountRequest {
  confirm: true;
  /** Checked again on the server against Supabase before anything changes. */
  password: string;
}

/**
 * A person's name as the member may type it: letters (any script, with their
 * accents), spaces, apostrophes, hyphens and dots — "Ma. Niña O'Brien-Santos".
 */
// Built from a string: the client compiles with target ES2017, and TypeScript
// refuses a `\p{…}` regex LITERAL below ES2018 although every browser we
// support runs it.
export const PERSON_NAME_PATTERN = new RegExp("^[\\p{L}\\p{M}][\\p{L}\\p{M} '’.-]*$", 'u');

/**
 * Bounds the API enforces and the account page checks before Save. One copy,
 * two runtimes. The SAME bounds sign-up accepts (server jwt-verifier.ts), so
 * any value already stored can be saved back unchanged.
 */
export const PROFILE_LIMITS = {
  heightCmMin: 50,
  heightCmMax: 260,
  weightKgMin: 20,
  weightKgMax: 400,
  medicalNotesMax: 2000,
  nameMax: NAME_MAX,
} as const;
