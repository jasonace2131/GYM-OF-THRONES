import { inviteRefusal, type StaffInvitationStatus, type StaffInvitationView } from '@got/shared';
import { toRoleName } from './staffRules';

/**
 * How the Staff & Access screen presents invitations. Pure: the page renders
 * what these return and decides nothing itself.
 */

export type BadgeTone = 'ok' | 'warn' | 'danger' | 'neutral';

/**
 * One status, one label, one tone. "Withdrawn", not "Revoked": the word staff
 * use at the counter. Pending is the one that needs somebody to act (chase
 * the invitee), so it is the warning; nothing here is danger.
 */
export function invitationBadge(status: StaffInvitationStatus): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'PENDING':
      return { label: 'Pending', tone: 'warn' };
    case 'EXPIRED':
      return { label: 'Expired', tone: 'neutral' };
    case 'ACCEPTED':
      return { label: 'Accepted', tone: 'ok' };
    case 'REVOKED':
      return { label: 'Withdrawn', tone: 'neutral' };
  }
}

/**
 * Resend and withdraw, for this caller. Only on an OPEN invitation (pending or
 * expired), and only when the caller could give its role — an ADMIN sees the
 * Super Admin's ADMIN invitation but cannot touch it, and the server would
 * refuse if they tried.
 */
export function invitationActions(
  invitation: StaffInvitationView,
  callerRole: string | null | undefined,
): { resend: boolean; revoke: boolean } {
  const role = toRoleName(callerRole);
  const open = invitation.status === 'PENDING' || invitation.status === 'EXPIRED';
  const may = role !== null && inviteRefusal({ inviter: role, role: invitation.role }) === null;
  return { resend: open && may, revoke: open && may };
}

const DAY_MS = 86_400_000;

/** The one line under an invitation saying where it stands. */
export function invitationTimeline(invitation: StaffInvitationView, now: Date): string {
  switch (invitation.status) {
    case 'PENDING': {
      const days = Math.floor((Date.parse(invitation.expiresAt) - now.getTime()) / DAY_MS);
      if (days <= 0) return 'Expires today';
      return days === 1 ? 'Expires tomorrow' : `Expires in ${days} days`;
    }
    case 'EXPIRED':
      return 'Expired — resend to give them a new link';
    case 'ACCEPTED':
      return invitation.acceptedBy === null
        ? 'Accepted'
        : `Accepted by ${invitation.acceptedBy.name}`;
    case 'REVOKED':
      return invitation.revokedBy === null
        ? 'Withdrawn'
        : `Withdrawn by ${invitation.revokedBy.name}`;
  }
}

/** Open invitations (something to do) above the recent history (nothing to do). */
export function splitInvitations(rows: readonly StaffInvitationView[]): {
  open: StaffInvitationView[];
  recent: StaffInvitationView[];
} {
  const isOpen = (row: StaffInvitationView): boolean =>
    row.status === 'PENDING' || row.status === 'EXPIRED';
  return { open: rows.filter(isOpen), recent: rows.filter((row) => !isOpen(row)) };
}
