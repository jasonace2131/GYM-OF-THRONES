import type {
  CoachProfileView,
  InvitableRole,
  IssuedStaffInvitation,
  PaginatedData,
  RoleName,
  StaffInviteAccepted,
  StaffInviteClaim,
  StaffInvitationLookup,
  StaffInvitationView,
} from '@got/shared';
import { apiFetch } from './api';
import type { MemberListItem } from './adminApi';
import type { CoachMemberRow } from './coachApi';
import type { CoachMemberProgress } from './progress/types';
import type { PermissionCatalogue, RoleGrants } from './staff/roleMatrix';

/**
 * Staff & Access, on the wire. Kept out of `adminApi.ts` so the console's
 * big fetcher file is not the one every feature branch edits at once.
 *
 * Every shape comes from `@got/shared` (`staff.types.ts`) — both ends of
 * these routes are new, so there is no older hand-copied mirror to keep in
 * step. Every id that becomes a path segment is encoded.
 */

const seg = (id: string): string => encodeURIComponent(id);

/** Mirrors `AdminCoachCaseload` (server/src/coaches/coach-caseload.service.ts). */
export interface AdminCoachCaseload {
  coach: {
    id: string;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
    role: RoleName;
  };
  /** Null for an admin who coaches: profiles are for the COACH role. */
  profile: CoachProfileView | null;
  /** The same rows the coach's own dashboard shows. */
  members: CoachMemberRow[];
}

export const staffApi = {
  /** Everybody who is not a member — `staff=true` is role ≠ CLIENT. */
  staff: (role?: RoleName): Promise<PaginatedData<MemberListItem>> =>
    apiFetch<PaginatedData<MemberListItem>>(
      `/members?staff=true&limit=100${role === undefined ? '' : `&role=${role}`}`,
    ),

  invitations: (): Promise<StaffInvitationView[]> =>
    apiFetch<StaffInvitationView[]>('/staff-invitations'),

  /** The role is a request; the server decides whether this caller may give it. */
  invite: (body: { email: string; role: InvitableRole }): Promise<IssuedStaffInvitation> =>
    apiFetch<IssuedStaffInvitation>('/staff-invitations', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  resendInvitation: (id: string): Promise<IssuedStaffInvitation> =>
    apiFetch<IssuedStaffInvitation>(`/staff-invitations/${seg(id)}/resend`, {
      method: 'POST',
      body: '{}',
    }),

  revokeInvitation: (id: string): Promise<StaffInvitationView> =>
    apiFetch<StaffInvitationView>(`/staff-invitations/${seg(id)}/revoke`, {
      method: 'POST',
      body: '{}',
    }),

  /** `permission.read`. The catalogue, grouped by resource. */
  permissionCatalogue: (): Promise<PermissionCatalogue> =>
    apiFetch<PermissionCatalogue>('/admin/permissions'),

  /** `permission.read`. The SEEDED grants per role; DEV is absent (it bypasses). */
  roleGrants: (): Promise<RoleGrants> => apiFetch<RoleGrants>('/admin/permissions/roles'),

  /** `coach.read`. Every live coach's profile the caller can reach. */
  coachProfiles: (): Promise<CoachProfileView[]> =>
    apiFetch<CoachProfileView[]>('/coaches/profiles'),

  /** `coach.read`. A coach at OWN reaches only their own. */
  coachProfile: (coachId: string): Promise<CoachProfileView> =>
    apiFetch<CoachProfileView>(`/coaches/${seg(coachId)}/profile`),

  /** `coach.profile.update`. Replaces both fields; `bio: null` clears it. */
  updateCoachProfile: (
    coachId: string,
    body: { specializations: string[]; bio: string | null },
  ): Promise<CoachProfileView> =>
    apiFetch<CoachProfileView>(`/admin/coaches/${seg(coachId)}/profile`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  /** `coach.read` at ALL. Read-only. */
  coachCaseload: (coachId: string): Promise<AdminCoachCaseload> =>
    apiFetch<AdminCoachCaseload>(`/admin/coaches/${seg(coachId)}/caseload`),

  /** `progress.read` at ALL — the Super Admin only. Read-only. */
  memberProgress: (memberId: string): Promise<CoachMemberProgress> =>
    apiFetch<CoachMemberProgress>(`/admin/members/${seg(memberId)}/progress`),
};

/**
 * The public invite page's three calls. Separate from `staffApi` because that
 * page is outside the console: it must not pull the console's fetchers into a
 * bundle a stranger with a link opens.
 */
export const inviteApi = {
  lookup: (token: string): Promise<StaffInvitationLookup> =>
    apiFetch<StaffInvitationLookup>(`/staff-invitations/lookup?token=${seg(token)}`),

  claimLink: (token: string): Promise<StaffInviteClaim> =>
    apiFetch<StaffInviteClaim>('/staff-invitations/claim-link', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  accept: (token: string): Promise<StaffInviteAccepted> =>
    apiFetch<StaffInviteAccepted>('/staff-invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
};
