import type { MemberNoticeFeedWire, MemberNoticesSeenWire } from '@got/shared';
import { apiFetch } from '@/lib/api';
import { NOTICE_PAGE_SIZE } from './feed';

/**
 * The two calls the bell makes for the member's own notices.
 *
 * Kept out of lib/announcements/api.ts on purpose: a different store with its
 * own read state, behind its own keyless /me routes, while GET
 * /me/announcements stays exactly as it is. Neither route takes a member id —
 * the server reads the subject from the token, never from the path or body.
 */

export function fetchMyNotices(page: number): Promise<MemberNoticeFeedWire> {
  return apiFetch<MemberNoticeFeedWire>(`/me/notices?page=${page}&limit=${NOTICE_PAGE_SIZE}`);
}

/**
 * Marks the member's notices up to `upTo` read and returns what is still
 * unread. `upTo` is the createdAt of the newest notice the bell SHOWED, never
 * "now": "now" would also mark a notice written between the fetch and this
 * POST, which the member never laid eyes on.
 */
export function markNoticesSeen(upTo: string): Promise<MemberNoticesSeenWire> {
  return apiFetch<MemberNoticesSeenWire>('/me/notices/seen', {
    method: 'POST',
    body: JSON.stringify({ upTo }),
  });
}
