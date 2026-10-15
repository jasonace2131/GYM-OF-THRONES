import type { Prisma } from '@prisma/client';
import type {
  Announcement as AnnouncementDto,
  AnnouncementDoc,
  MemberAnnouncement,
} from '@got/shared';

/**
 * The author columns every announcement read includes — shared by the admin
 * list and the member feed, so both name the author the same way and neither
 * can widen what a member learns about staff.
 */
export const AUTHOR_SELECT = {
  select: { id: true, firstName: true, lastName: true },
} as const;

/** Exactly the columns the presenter reads. Keeps the service's select honest. */
export interface AnnouncementRow {
  id: string;
  title: string;
  content: string;
  /** Sanitised on the way in (rich-content.ts); NULL for a plain notice. */
  contentJson: Prisma.JsonValue | null;
  coverImageUrl: string | null;
  isPinned: boolean;
  createdAt: Date;
  updatedAt: Date;
  author: { id: string; firstName: string; lastName: string };
}

/**
 * Projects a row onto the wire shape.
 *
 * Instants are ISO strings, never pre-formatted — every surface renders its
 * own with an explicit `timeZone`, the same rule money follows with centavos.
 * A formatted date in a response body is a date formatted in the server's zone
 * and shipped to a phone in another one.
 *
 * The author is named because a notice from the owner and a notice from the
 * front desk carry different weight, and a member should be able to tell.
 * Nothing else about the author is exposed: no email, no role, no member code.
 */
export function toAnnouncement(row: AnnouncementRow): AnnouncementDto {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    // Passed through as stored: every write went through the allowlist, the
    // CHECK guarantees a `doc` root, and the client's renderer maps only the
    // allowlisted node types to elements — it never interprets HTML.
    contentJson: (row.contentJson ?? null) as unknown as AnnouncementDoc | null,
    coverImageUrl: row.coverImageUrl,
    isPinned: row.isPinned,
    author: {
      id: row.author.id,
      firstName: row.author.firstName,
      lastName: row.author.lastName,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The one ordering, defined once.
 *
 * Pinned first, then newest. Exported so the list query and any future feed
 * cannot disagree about what "the announcements" means — and so the index in
 * the migration has something to be checked against.
 */
export const ANNOUNCEMENT_ORDER = [
  { isPinned: 'desc' as const },
  { createdAt: 'desc' as const },
];

/**
 * A notice as one member sees it: the wire shape plus `isNew`.
 *
 * `floor` is the member's EFFECTIVE watermark (announcement-watermark.ts), and
 * the comparison is STRICT. Opening the bell sets the watermark to the
 * createdAt of the newest notice shown, so that notice must read as seen
 * afterwards — `>=` would leave the one they just looked at lit forever.
 */
export function toMemberAnnouncement(row: AnnouncementRow, floor: Date): MemberAnnouncement {
  return { ...toAnnouncement(row), isNew: row.createdAt.getTime() > floor.getTime() };
}

/**
 * The member feed's ordering — CHRONOLOGICAL, deliberately not
 * `ANNOUNCEMENT_ORDER`.
 *
 * The bell is a "what just happened" list. Pinned-first would park an old
 * pinned notice at its top forever and push the notice that went up a minute
 * ago beneath it. Pinned notices travel separately (`MemberAnnouncementFeed.
 * pinned`), which is where the dashboard leads with them.
 *
 * The id tie-break makes the order total, so a page boundary between two
 * notices saved in the same millisecond can neither repeat nor drop one.
 */
export const MEMBER_FEED_ORDER = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
