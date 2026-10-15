import type { MemberAnnouncement, MemberNoticeWire } from '@got/shared';
import { noticeHref } from '@/lib/announcements/focus';
import { safeNext } from '@/lib/safeNext';
import { compareNewest } from './feed';

/**
 * The bell over two feeds: the gym's announcements (one board every member
 * reads) and the member's own notices (a seat that opened up, a class called
 * off). Pure, so the merge, the marks and the links are pinned by tests rather
 * than by reading JSX.
 *
 * The console mounts the same bell with announcements only — it has no notices
 * provider — and every helper here takes an empty notices list for that.
 */

/** Rows the dropdown lists, across both feeds. */
export const BELL_ROWS = 8;

export type BellRow =
  | { source: 'announcement'; item: MemberAnnouncement }
  | { source: 'notice'; item: MemberNoticeWire };

/**
 * The dropdown's rows: both feeds in one list, newest first (`createdAt`, then
 * `id`, descending — each feed's own server order), cut at `limit`.
 *
 * Page one of each feed is enough: each is newest first and at least `limit`
 * long, so the newest `limit` of the union are always inside the two pages.
 */
export function bellRows(
  announcements: readonly MemberAnnouncement[],
  notices: readonly MemberNoticeWire[],
  limit: number = BELL_ROWS,
): BellRow[] {
  const rows: BellRow[] = [
    ...announcements.map((item): BellRow => ({ source: 'announcement', item })),
    ...notices.map((item): BellRow => ({ source: 'notice', item })),
  ];
  return rows.sort((a, b) => compareNewest(a.item, b.item)).slice(0, limit);
}

/** A row's React key: the two feeds are separate tables, so ids alone could meet. */
export function bellRowKey(row: BellRow): string {
  return `${row.source}:${row.item.id}`;
}

export interface SeenMarks {
  announcements: string | null;
  notices: string | null;
}

/**
 * What opening the bell marks seen, feed by feed: the `createdAt` of that
 * feed's newest row ON SCREEN — never "now", which would also cover a row
 * written between the fetch and the POST.
 *
 * A feed with no row among `rows` marks NOTHING. Its rows were all pushed past
 * the cut by the other feed's newer ones, the member never saw them, and they
 * stay new: the badge keeps counting them and "Mark all read" still offers to
 * clear them. Both seen routes mark everything at or before the instant they
 * are given, so a row above the cut that IS shown still covers the older rows
 * of its feed beyond the cut — the watermark rule the announcements bell has
 * always had.
 */
export function seenMarks(rows: readonly BellRow[]): SeenMarks {
  const marks: SeenMarks = { announcements: null, notices: null };
  for (const row of rows) {
    const key = row.source === 'announcement' ? 'announcements' : 'notices';
    const mark = marks[key];
    if (mark === null || Date.parse(row.item.createdAt) > Date.parse(mark)) {
      marks[key] = row.item.createdAt;
    }
  }
  return marks;
}

/**
 * Where a row goes, or null for a row that goes nowhere.
 *
 * An announcement opens on the noticeboard (`?notice=<id>` on this surface's
 * dashboard), always. A member's notice goes to its OWN `linkPath` — NEVER
 * through `noticeHref`: the dashboard would look its id up as an announcement,
 * fail, and tell the member "That announcement is no longer available".
 */
export function bellRowHref(
  row: Extract<BellRow, { source: 'announcement' }>,
  noticesHome: string,
): string;
export function bellRowHref(row: BellRow, noticesHome: string): string | null;
export function bellRowHref(row: BellRow, noticesHome: string): string | null {
  return row.source === 'announcement'
    ? noticeHref(row.item.id, noticesHome)
    : noticeLink(row.item.linkPath);
}

/**
 * A notice's `linkPath` if it is a real in-app destination, else null.
 *
 * The database already refuses anything else (CHECK
 * `MemberNotice_link_is_internal`); this is the second lock on a value the
 * bell renders as a link. `safeNext` is the one function this client trusts
 * with "is this path inside the app": it refuses `//host` and `/\host`, `..`
 * segments, and anything outside the known surfaces.
 */
export function noticeLink(linkPath: string | null): string | null {
  if (linkPath === null || linkPath === '') return null;
  return safeNext(linkPath, '') === linkPath ? linkPath : null;
}

/** The part of either feed's state the bell's view depends on. */
export interface BellFeedStatus {
  status: 'idle' | 'loading' | 'ready' | 'error';
  forbidden: boolean;
}

export type BellView = 'loading' | 'error' | 'empty' | 'list';

/**
 * What the dropdown's body shows, given each feed's state and how many rows
 * the merge produced.
 *
 * A feed this account may not read (403) is left out entirely. Rows win: any
 * row on screen means the list, even while the other feed is still loading
 * or has failed — `partialFailure` then asks for a quiet "some couldn't load"
 * line instead of hiding what did arrive. With no rows, a feed still on its
 * first load means the skeleton, so "nothing yet" never flashes before it.
 */
export function bellView(
  feeds: readonly BellFeedStatus[],
  rowCount: number,
): { view: BellView; partialFailure: boolean } {
  const live = feeds.filter((feed) => !feed.forbidden);
  const failed = live.some((feed) => feed.status === 'error');
  if (rowCount > 0) return { view: 'list', partialFailure: failed };
  if (live.some((feed) => feed.status === 'idle' || feed.status === 'loading')) {
    return { view: 'loading', partialFailure: false };
  }
  return { view: failed ? 'error' : 'empty', partialFailure: false };
}
