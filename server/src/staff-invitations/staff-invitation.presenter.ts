import type { StaffInvitation } from '@prisma/client';
import type { InvitableRole, StaffInvitationPerson, StaffInvitationView } from '@got/shared';
import { invitationStatus } from './invitation-token';

const PERSON = { select: { id: true, firstName: true, lastName: true } } as const;

/** The one include every read of an invitation uses: the three people it names. */
export const STAFF_INVITATION_INCLUDE = {
  invitedBy: PERSON,
  acceptedBy: PERSON,
  revokedBy: PERSON,
} as const;

type Person = { id: string; firstName: string; lastName: string };

export type StaffInvitationRow = StaffInvitation & {
  invitedBy: Person;
  acceptedBy: Person | null;
  revokedBy: Person | null;
};

function toPerson(row: Person): StaffInvitationPerson {
  return { id: row.id, name: `${row.firstName} ${row.lastName}`.trim() };
}

/**
 * Row → wire. The token HASH never leaves the server: it is not a secret by
 * itself, but nothing on the screen needs it and a hash on the wire invites
 * somebody to reason about it.
 */
export function toStaffInvitationView(row: StaffInvitationRow, now: Date): StaffInvitationView {
  return {
    id: row.id,
    email: row.email,
    // The CHECK (StaffInvitation_role_staff) is what makes this narrowing true.
    role: row.role as InvitableRole,
    status: invitationStatus(row, now),
    invitedBy: toPerson(row.invitedBy),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    acceptedBy: row.acceptedBy === null ? null : toPerson(row.acceptedBy),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy === null ? null : toPerson(row.revokedBy),
  };
}
