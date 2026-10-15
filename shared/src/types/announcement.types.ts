// Announcement domain types

import type { PaginatedData } from './api.types';
import type { AnnouncementDoc } from '../announcements/rich-text';

export interface Announcement {
  id: string;
  title: string;
  /**
   * Always plain text. For a rich notice it is derived from `contentJson` on
   * the server — previews, the bell and the pinned banner read this and never
   * the JSON.
   */
  content: string;
  /**
   * The body as sanitised ProseMirror JSON, or null for a plain-text notice
   * (every notice posted before rich text shipped). Render it with
   * `RichContent`; never as HTML.
   */
  contentJson: AnnouncementDoc | null;
  /** An image in the public `announcements` bucket, shown above the body. */
  coverImageUrl: string | null;
  isPinned: boolean;
  author: {
    id: string;
    firstName: string;
    lastName: string;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * One notice as a MEMBER sees it — the wire `Announcement` plus whether it is
 * new to them.
 *
 * `isNew` is decided on the server against the member's watermark
 * (`User.announcementsSeenAt`, floored by a 30-day horizon), so the bell's
 * count and the dots on the rows cannot disagree about what "new" means.
 */
export interface MemberAnnouncement extends Announcement {
  isNew: boolean;
}

/**
 * `GET /me/announcements` — the member's feed.
 *
 * `items` are CHRONOLOGICAL (newest first), not pinned-first: pinned-first
 * would park an old pinned notice at the top of the bell forever and push the
 * thing that just happened below it. Pinned notices travel separately in
 * `pinned`, which the dashboard leads with.
 */
export interface MemberAnnouncementFeed extends PaginatedData<MemberAnnouncement> {
  /** Every pinned notice, newest first, at most five. Independent of `page`. */
  pinned: MemberAnnouncement[];
  /** Notices created after the member's watermark. Independent of `page`. */
  unreadCount: number;
}

/** `POST /me/announcements/seen` — the watermark after the write. */
export interface AnnouncementsSeen {
  /** The effective watermark (ISO), after the horizon floor is applied. */
  seenAt: string;
  unreadCount: number;
}

/**
 * `GET /admin/announcements/uploads` — whether the composer may offer images.
 * False when the server has no `SUPABASE_SERVICE_KEY`; the editor then hides
 * its image and cover buttons rather than showing a door that does not open.
 */
export interface AnnouncementUploadStatus {
  enabled: boolean;
}

/**
 * `POST /admin/announcements/uploads` — a one-shot signed URL the browser PUTs
 * the (already resized) image to, straight to Supabase Storage.
 */
export interface AnnouncementImageUpload {
  /** The object key inside the bucket: `announcements/<uuid>.<ext>`. */
  path: string;
  /** Where to PUT the bytes. Single use. */
  uploadUrl: string;
  /** Supabase's token for the same upload, for its JS client. */
  token: string;
  /** The URL the editor inserts — the only kind of image `src` the API accepts. */
  publicUrl: string;
}
