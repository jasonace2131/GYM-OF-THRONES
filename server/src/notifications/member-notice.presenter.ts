import type { MemberNoticeKind, Prisma } from '@prisma/client';
import type { MemberNoticeWire } from '@got/shared';

/**
 * Exactly the columns the presenter reads, and `MEMBER_NOTICE_SELECT` loads
 * exactly these — so the service cannot quietly fetch more than it sends.
 *
 * `userId`, `subjectType`, `subjectId` and `dedupeKey` are deliberately absent.
 * The recipient is always the caller (these are /me routes), and the subject
 * and the dedupe key are the producer's bookkeeping: a client that could see
 * them would start building on them. What a row opens is its `linkPath`.
 */
export interface MemberNoticeRow {
  id: string;
  kind: MemberNoticeKind;
  title: string;
  body: string | null;
  linkPath: string | null;
  readAt: Date | null;
  createdAt: Date;
}

/** The select that yields a `MemberNoticeRow`, and nothing more. */
export const MEMBER_NOTICE_SELECT = {
  id: true,
  kind: true,
  title: true,
  body: true,
  linkPath: true,
  readAt: true,
  createdAt: true,
} as const satisfies Prisma.MemberNoticeSelect;

/**
 * Newest first, with the id as the tie-break — the order of the
 * `MemberNotice_userId_createdAt_id_idx` index the migration built for this
 * exact query.
 *
 * The tie-break is not decoration. One createMany writes a whole batch, so a
 * member can hold two notices stamped in the same millisecond (a class edit
 * that also promotes them sends CLASS_CHANGED and CLASS_PROMOTED together);
 * without a total order a page boundary between the two could repeat one and
 * drop the other.
 */
export const MEMBER_NOTICE_ORDER = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/**
 * A notice as its member sees it.
 *
 * `isNew` is the row's OWN read state. An announcement is new when it is newer
 * than one watermark per member, floored at 30 days; a notice was written to
 * one person about something that happened to THEM, so it stays lit until
 * they open the bell over it, however long that takes.
 *
 * The instant goes out as an ISO string, never pre-formatted. The title and
 * body are different: they are sentences composed in gym time when the notice
 * was written and stored as sent, so the bell shows what the member was told
 * even after the class changes again.
 */
export function toMemberNotice(row: MemberNoticeRow): MemberNoticeWire {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    linkPath: row.linkPath,
    isNew: row.readAt === null,
    createdAt: row.createdAt.toISOString(),
  };
}
