import type { AuditAction, AuditLog, Role } from '@prisma/client';

/**
 * An audit entry on the wire.
 *
 * `actorName` rather than a bare `actorId`, because the whole point of the
 * screen is to answer "who". A line reading "voided by a3f1c9d2…" is one
 * nobody can act on — the same argument the receipt presenter makes for
 * including `recordedBy`.
 *
 * `originIpHash` is deliberately ABSENT. It exists so two entries can be
 * recognised as coming from the same place, which is a forensic question
 * answered against the database, not a column to put on a table in a
 * back office. Shipping it would put a stable per-address identifier on a
 * screen for no operational gain.
 */
export interface AuditEntryView {
  id: string;
  action: AuditAction;
  actorId: string;
  actorName: string;
  /** The actor's role AT THE TIME, not their role now. */
  actorRole: Role;
  subjectType: string;
  subjectId: string | null;
  subjectLabel: string | null;
  reason: string | null;
  details: unknown;
  occurredAt: string;
}

export type AuditLogRow = AuditLog & {
  actor: { firstName: string; lastName: string };
};

export function toAuditEntryView(row: AuditLogRow): AuditEntryView {
  return {
    id: row.id,
    action: row.action,
    actorId: row.actorId,
    actorName: `${row.actor.firstName} ${row.actor.lastName}`.trim(),
    actorRole: row.actorRole,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    subjectLabel: row.subjectLabel,
    reason: row.reason,
    details: row.details,
    occurredAt: row.occurredAt.toISOString(),
  };
}

/** The one include every read here uses, so the four call sites cannot drift. */
export const AUDIT_INCLUDE = {
  actor: { select: { firstName: true, lastName: true } },
} as const;
