import type { MemberNoticeFeedWire, MemberNoticeWire } from '@got/shared';

/**
 * The member's own notices — the personal half of the bell, beside the
 * announcements feed (lib/announcements/feed.ts) and deliberately apart from
 * it. An announcement is one row every member reads, measured against ONE
 * watermark per member; a notice is written to one member and carries its OWN
 * read state (`readAt` on the row). Same bell, same rules, different store.
 *
 * Pure: `MemberNoticesProvider` owns the fetching and the clock, and
 * dispatches here.
 *
 * PAGE ONE ONLY. The bell lists the newest rows of both feeds and nothing else
 * reads this one, so there is no "load more" and a refresh REPLACES the list
 * rather than merging into it. A merged list would keep showing a notice the
 * server no longer puts on page one, and the bell would stop marking seen
 * exactly what it shows.
 */

/** Rows per request — the same page size the announcements feed asks for. */
export const NOTICE_PAGE_SIZE = 10;

/** The last `upTo` the bell sent, and whether it landed. */
export interface SeenMark {
  upTo: string;
  status: 'pending' | 'ok' | 'failed';
}

export interface NoticeFeedState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** 403: this account cannot read its notices — the bell drops this feed. */
  forbidden: boolean;
  /** A refresh failed while older notices are still on screen. */
  stale: boolean;
  /** Page one, newest first (`createdAt`, then `id`, both descending). */
  items: MemberNoticeWire[];
  unreadCount: number;
  /** `Date.now()` of the last successful load. */
  loadedAt: number | null;
  panelOpen: boolean;
  /**
   * The count to put back if the mark in flight fails — the server's last
   * word before the optimistic zero, or a newer one (see `loaded`).
   */
  countBeforeSeen: number | null;
  seen: SeenMark | null;
}

export const INITIAL_NOTICE_FEED: NoticeFeedState = {
  status: 'idle',
  forbidden: false,
  stale: false,
  items: [],
  unreadCount: 0,
  loadedAt: null,
  panelOpen: false,
  countBeforeSeen: null,
  seen: null,
};

export type NoticeFeedAction =
  | { type: 'loadStarted' }
  | { type: 'loaded'; feed: MemberNoticeFeedWire; at: number }
  | { type: 'loadFailed'; forbidden: boolean }
  | { type: 'panelOpened' }
  /** Count → 0 at once; the dots stay until the panel closes. */
  | { type: 'seenRequested'; upTo: string }
  /** Tagged with its own `upTo`, so a late answer cannot settle a newer mark. */
  | { type: 'seenSucceeded'; upTo: string; unreadCount: number }
  /** The count comes back; the dots never left. */
  | { type: 'seenFailed'; upTo: string }
  | { type: 'panelClosed' }
  /** Clears every dot and the count now; the provider sends the mark. */
  | { type: 'markAllRead' };

export function noticeFeedReducer(
  state: NoticeFeedState,
  action: NoticeFeedAction,
): NoticeFeedState {
  switch (action.type) {
    case 'loadStarted':
      // A background refresh must not flash the skeleton over real rows.
      return { ...state, status: state.status === 'ready' ? 'ready' : 'loading' };

    case 'loaded': {
      const pending = state.seen?.status === 'pending';
      return {
        ...state,
        status: 'ready',
        forbidden: false,
        stale: false,
        items: settleDots(state, action.feed.items),
        // ═══ THE IN-FLIGHT RULE ═══ While the bell's mark is in flight the
        // server still counts what is about to be marked seen; taking its
        // number would flash the badge straight back. It IS the number to fall
        // back on if that mark fails — fresher than the one taken at the open.
        unreadCount: pending ? state.unreadCount : action.feed.unreadCount,
        countBeforeSeen: pending ? action.feed.unreadCount : state.countBeforeSeen,
        loadedAt: action.at,
      };
    }

    case 'loadFailed':
      if (action.forbidden) return { ...state, forbidden: true, status: 'error' };
      return state.status === 'ready' ? { ...state, stale: true } : { ...state, status: 'error' };

    case 'panelOpened':
      return { ...state, panelOpen: true };

    case 'seenRequested': {
      // A second mark while one is in flight keeps the count from before the
      // FIRST: the zero on screen is optimistic, not a number to restore.
      const pending = state.seen?.status === 'pending';
      return {
        ...state,
        countBeforeSeen: pending ? state.countBeforeSeen : state.unreadCount,
        unreadCount: 0,
        seen: { upTo: action.upTo, status: 'pending' },
      };
    }

    case 'seenSucceeded':
      if (state.seen?.upTo !== action.upTo) {
        // A late answer to an older mark. Its recount predates the newer mark
        // still in flight, so it must not move the badge — but it is the
        // server's latest word if that newer mark fails.
        return state.seen?.status === 'pending'
          ? { ...state, countBeforeSeen: action.unreadCount }
          : state;
      }
      return {
        ...state,
        unreadCount: action.unreadCount,
        countBeforeSeen: null,
        seen: { ...state.seen, status: 'ok' },
      };

    case 'seenFailed':
      if (state.seen?.upTo !== action.upTo) return state;
      return {
        ...state,
        unreadCount: state.countBeforeSeen ?? state.unreadCount,
        countBeforeSeen: null,
        seen: { ...state.seen, status: 'failed' },
      };

    case 'panelClosed': {
      const mark = markedUpTo(state.seen);
      return {
        ...state,
        panelOpen: false,
        items: mark === null ? state.items : clearUpTo(state.items, mark),
      };
    }

    case 'markAllRead':
      // `countBeforeSeen` is left alone on purpose: if the mark the provider
      // sent with this fails, the count comes back and says so.
      return {
        ...state,
        unreadCount: 0,
        items: state.items.map((notice) => (notice.isNew ? { ...notice, isNew: false } : notice)),
      };
  }
}

/**
 * The incoming page, newest first, with its dots settled against what the
 * member has already been shown.
 *
 * Panel OPEN: a dot that was lit stays lit (owner decision for the bell —
 * rows stay visibly new while the dropdown is open). Panel CLOSED: a row at
 * or before a mark that did not fail is read, whatever this response says —
 * a GET that reached the server just before the POST still calls it new, and
 * believing it would relight a dot the member already cleared.
 */
function settleDots(
  state: NoticeFeedState,
  incoming: readonly MemberNoticeWire[],
): MemberNoticeWire[] {
  const sorted = noticesNewestFirst(incoming);
  if (state.panelOpen) {
    const lit = new Set(state.items.filter((notice) => notice.isNew).map((notice) => notice.id));
    return sorted.map((notice) =>
      !notice.isNew && lit.has(notice.id) ? { ...notice, isNew: true } : notice,
    );
  }
  const mark = markedUpTo(state.seen);
  return mark === null ? sorted : clearUpTo(sorted, mark);
}

/** The instant of a mark that has not failed, or null. */
function markedUpTo(seen: SeenMark | null): number | null {
  return seen === null || seen.status === 'failed' ? null : Date.parse(seen.upTo);
}

function clearUpTo(items: readonly MemberNoticeWire[], mark: number): MemberNoticeWire[] {
  return items.map((notice) =>
    notice.isNew && Date.parse(notice.createdAt) <= mark ? { ...notice, isNew: false } : notice,
  );
}

/**
 * The bell's one order, for both feeds: `createdAt` descending, then `id`
 * descending — the server's order for each, so a tie never reshuffles.
 */
export function compareNewest(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (diff !== 0) return diff;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function noticesNewestFirst(items: readonly MemberNoticeWire[]): MemberNoticeWire[] {
  return [...items].sort(compareNewest);
}

/** The newest `createdAt` among `items`, or null for none. */
export function newestNoticeAt(items: readonly MemberNoticeWire[]): string | null {
  let newest: MemberNoticeWire | null = null;
  for (const notice of items) {
    if (newest === null || Date.parse(notice.createdAt) > Date.parse(newest.createdAt)) {
      newest = notice;
    }
  }
  return newest === null ? null : newest.createdAt;
}

/** Whether any row still shows a "new" dot — drives "Mark all read". */
export function hasNewNotices(state: Pick<NoticeFeedState, 'items'>): boolean {
  return state.items.some((notice) => notice.isNew);
}

/**
 * Whether a mark at or past `upTo` is already IN FLIGHT, so sending another
 * would only race it — the bell opened twice before the first POST landed, or
 * "Mark all read" pressed while the open's mark is still on its way.
 *
 * A mark that LANDED does not count. Both seen routes only move forward, so
 * sending again is one idempotent request; and when the server still counts
 * something unread at or before an old mark (a GET it answered just before
 * the POST, a row that committed late), sending again is the only thing that
 * puts the badge right. Skipping it would leave that count stuck for good.
 * The shape matches the announcements feed's `seen`, and its provider uses
 * this too.
 */
export function markInFlight(seen: SeenMark | null, upTo: string): boolean {
  return seen !== null && seen.status === 'pending' && Date.parse(seen.upTo) >= Date.parse(upTo);
}
