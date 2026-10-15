// Staff & Access — the wire shapes the API sends and the console reads.
//
// Declared once here rather than mirrored by hand in `adminApi.ts`: both ends
// of every one of these routes are new, so there is no older copy to keep in
// step, and the invite page (a public route) and the console share them.

import type { InvitableRole, RoleName } from '../rbac/role-hierarchy';

/**
 * Where an invitation stands. Derived from its timestamps at read time —
 * there is no status column, so there is no nightly job that could fall
 * behind and leave a dead link reading "pending".
 */
export type StaffInvitationStatus = 'PENDING' | 'EXPIRED' | 'ACCEPTED' | 'REVOKED';

/** A person an invitation names, as the list shows them. */
export interface StaffInvitationPerson {
  id: string;
  name: string;
}

/**
 * One row of `GET /staff-invitations`. Never the token or its hash: the raw
 * token exists only in the link, shown once when it is issued.
 */
export interface StaffInvitationView {
  id: string;
  email: string;
  role: InvitableRole;
  status: StaffInvitationStatus;
  invitedBy: StaffInvitationPerson;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: StaffInvitationPerson | null;
  revokedAt: string | null;
  revokedBy: StaffInvitationPerson | null;
}

/**
 * `POST /staff-invitations` and `POST /staff-invitations/:id/resend`.
 *
 * `link` is returned ONCE, so the admin can copy it — the same pattern as a
 * resend-invite whose email could not be sent. It is not stored anywhere the
 * API can read it back.
 */
export interface IssuedStaffInvitation {
  invitation: StaffInvitationView;
  link: string;
  emailSent: boolean;
}

/**
 * `GET /staff-invitations/lookup?token=` — public. Only the role and a masked
 * address (`ma***@gmail.com`): enough for the invitee to recognise their own
 * invitation, too little to learn anybody's email from a leaked link.
 */
export interface StaffInvitationLookup {
  role: InvitableRole;
  maskedEmail: string;
}

/**
 * `POST /staff-invitations/claim-link` — public.
 *
 * `REDIRECT`: a brand-new account was set up for the invited address; the
 * browser follows `url` (a Supabase link) and comes back to the invite page
 * signed in.
 *
 * `SIGN_IN`: that address already has an account. The invitee signs in the
 * usual way and comes back — the API never hands a sign-in link for an
 * EXISTING account to whoever holds the invitation token.
 */
export type StaffInviteClaim = { kind: 'REDIRECT'; url: string } | { kind: 'SIGN_IN' };

/** `POST /staff-invitations/accept`. `changed` is false when they already held the role. */
export interface StaffInviteAccepted {
  role: RoleName;
  changed: boolean;
}

/**
 * What members read about a coach. `updatedAt` is null for a coach nobody has
 * written a profile for yet — rendered as "no profile yet", never as an empty
 * card pretending to be one.
 */
export interface CoachProfileView {
  userId: string;
  specializations: string[];
  bio: string | null;
  updatedAt: string | null;
}

/** The limits the database enforces (CoachProfile_*_shape), for forms to count against. */
export const COACH_PROFILE_LIMITS = Object.freeze({
  specializations: 5,
  specializationLength: 40,
  bioLength: 500,
});
