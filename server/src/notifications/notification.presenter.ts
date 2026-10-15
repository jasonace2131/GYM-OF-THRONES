import type { NotificationSeverity, SystemNotification, SystemNotificationKind } from '@prisma/client';

/**
 * A system notification on the wire.
 *
 * `readById` / `resolvedById` are deliberately absent. The panel says "seen"
 * and "dealt with", never "seen by a3f1c9d2…", and shipping a bare uuid would
 * invite a client to render one. If a screen ever needs the name, this
 * projection grows a `resolvedByName` — never the raw id.
 */
export interface SystemNotificationView {
  id: string;
  kind: SystemNotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  /** An in-app path, never an external URL. The database enforces that. */
  linkPath: string | null;
  subjectType: string | null;
  subjectId: string | null;
  readAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export function toSystemNotificationView(row: SystemNotification): SystemNotificationView {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    linkPath: row.linkPath,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    readAt: row.readAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The badge's numbers, so no screen counts a truncated page and calls it a total. */
export interface NotificationCounts {
  unread: number;
  unresolved: number;
  /** Archived (resolved) notices: the Archived tab's total. */
  archived: number;
}
