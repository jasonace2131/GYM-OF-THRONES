import type {
  Announcement,
  AnnouncementsSeen,
  MemberAnnouncement,
  MemberAnnouncementFeed,
} from '@got/shared';
import { apiFetch } from '@/lib/api';
import { FEED_PAGE_SIZE } from './feed';

/**
 * The three calls the bell and the dashboard make. There is deliberately no
 * `/announcements?…` list call here: that one is pinned-first for the admin
 * board, and the member feed is chronological with pinned alongside.
 */

export function fetchMemberFeed(page: number): Promise<MemberAnnouncementFeed> {
  return apiFetch<MemberAnnouncementFeed>(`/me/announcements?page=${page}&limit=${FEED_PAGE_SIZE}`);
}

/** `upTo` is the createdAt of the newest notice SHOWN — see `newestCreatedAt`. */
export function markAnnouncementsSeen(upTo: string): Promise<AnnouncementsSeen> {
  return apiFetch<AnnouncementsSeen>('/me/announcements/seen', {
    method: 'POST',
    body: JSON.stringify({ upTo }),
  });
}

/**
 * One notice by id — the deep link's fallback for a notice beyond the loaded
 * pages. Such a notice is older than every loaded page, so it is never new.
 */
export async function fetchAnnouncement(id: string): Promise<MemberAnnouncement> {
  const notice = await apiFetch<Announcement>(`/announcements/${id}`);
  return { ...notice, isNew: false };
}
