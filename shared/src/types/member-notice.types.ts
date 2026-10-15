// A member's own notices — the personal half of the portal bell.
//
// Announcements are one board every member reads, with one watermark per
// member. These are written TO one member about something that happened to
// THEM — a waitlist place that turned into a seat, a class called off — and
// each one carries its own read state.

import type { PaginatedData } from './api.types';

/**
 * Every kind of member notice, mirroring the Prisma enum `MemberNoticeKind`
 * (server/prisma/schema/enums.prisma) value for value. A plain list rather than
 * a TS enum: no screen branches on the kind to decide what to render — a
 * notice is its stored title, body and link — so this exists for the type
 * below, and so a server spec can check the two lists still agree (a union
 * type alone has nothing to compare at run time).
 */
export const MEMBER_NOTICE_KINDS = [
  // The waitlist moved them into a seat.
  'CLASS_PROMOTED',
  // The gym called off a class they were booked or waitlisted for.
  'CLASS_CANCELLED',
  // The time, coach or title of a class they hold a place in changed.
  'CLASS_CHANGED',
  // The desk booked them in, or put them on the waitlist, by hand.
  'BOOKING_ADDED',
  // The desk took them out of a class, with a reason.
  'BOOKING_REMOVED',
] as const;

export type MemberNoticeKind = (typeof MEMBER_NOTICE_KINDS)[number];

/**
 * One notice as its member sees it.
 *
 * `title` and `body` are complete sentences composed on the server when the
 * notice was written and stored as they were sent, so the bell shows what the
 * member was told, even after the class changes again. `linkPath` is an
 * in-app path (never an external URL) the row opens — never an announcement
 * id. `isNew` is this row's own read state: true until the member opens the
 * bell over it.
 */
export interface MemberNoticeWire {
  id: string;
  kind: MemberNoticeKind;
  title: string;
  body: string | null;
  linkPath: string | null;
  isNew: boolean;
  createdAt: string;
}

/**
 * `GET /me/notices` — the member's own notices, newest first (`createdAt`
 * desc, then `id` desc, so a page boundary never repeats or skips a row).
 */
export interface MemberNoticeFeedWire extends PaginatedData<MemberNoticeWire> {
  /** Unread notices in total. Independent of `page`. */
  unreadCount: number;
}

/** `POST /me/notices/seen` — the count left unread after the write. */
export interface MemberNoticesSeenWire {
  unreadCount: number;
}
