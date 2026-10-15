import type { MemberAnnouncement, MemberAnnouncementFeed } from '@got/shared';

/**
 * The member's announcements feed — ONE state shared by the bell and the
 * dashboard, so opening the dashboard after the bell (or the other way round)
 * never fetches twice and the two can never disagree about what is new.
 *
 * Pure: the provider owns the fetching and the clock, and dispatches here.
 */

/** Rows per request. The bell shows the first page; the dashboard reveals more. */
export const FEED_PAGE_SIZE = 10;

export interface FeedState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** 403: this account cannot read announcements at all — the bell hides. */
  forbidden: boolean;
  /** A refresh failed while older notices are still on screen. */
  stale: boolean;
  /** Chronological, newest first, every page loaded so far (plus injected). */
  items: MemberAnnouncement[];
  /** Every pinned notice, newest first, at most five (server-capped). */
  pinned: MemberAnnouncement[];
  total: number;
  /** The highest page loaded; 0 before the first load. */
  page: number;
  totalPages: number;
  unreadCount: number;
  /** `Date.now()` of the last successful first-page load. */
  loadedAt: number | null;
  loadingMore: boolean;
  panelOpen: boolean;
  /** The count before an optimistic `seen`, restored if the POST fails. */
  countBeforeSeen: number | null;
  /** The last watermark sent, and whether it landed. */
  seen: { upTo: string; status: 'pending' | 'ok' | 'failed' } | null;
}

export const INITIAL_FEED: FeedState = {
  status: 'idle',
  forbidden: false,
  stale: false,
  items: [],
  pinned: [],
  total: 0,
  page: 0,
  totalPages: 0,
  unreadCount: 0,
  loadedAt: null,
  loadingMore: false,
  panelOpen: false,
  countBeforeSeen: null,
  seen: null,
};

export type FeedAction =
  | { type: 'loadStarted'; mode: 'first' | 'append' }
  | { type: 'loaded'; mode: 'first' | 'append'; feed: MemberAnnouncementFeed; at: number }
  | { type: 'loadFailed'; mode: 'first' | 'append'; forbidden: boolean }
  | { type: 'panelOpened' }
  /** Count → 0 at once; the dots stay until the panel closes. */
  | { type: 'seenRequested'; upTo: string }
  | { type: 'seenSucceeded'; unreadCount: number }
  /** The count comes back; the dots never left. */
  | { type: 'seenFailed' }
  | { type: 'panelClosed' }
  /**
   * Clears every dot and the count now. The provider sends the mark first
   * (`seenRequested`); if it fails, `seenFailed` puts the count back.
   */
  | { type: 'markAllRead' }
  /** A deep-linked notice from beyond the loaded pages. */
  | { type: 'noticeInjected'; notice: MemberAnnouncement };

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  switch (action.type) {
    case 'loadStarted':
      return action.mode === 'append'
        ? { ...state, loadingMore: true }
        : { ...state, status: state.status === 'ready' ? 'ready' : 'loading' };

    case 'loaded': {
      const keepNew = state.panelOpen;
      const { feed } = action;
      // While the bell's POST is in flight the server still counts what we are
      // about to mark seen; taking its number would flash the badge back.
      const unreadCount = state.seen?.status === 'pending' ? state.unreadCount : feed.unreadCount;
      const base = {
        ...state,
        status: 'ready' as const,
        forbidden: false,
        stale: false,
        items: mergeItems(state.items, feed.items, { keepNew }),
        pinned: mergeItems(
          state.pinned.filter((notice) => feed.pinned.some((next) => next.id === notice.id)),
          feed.pinned,
          { keepNew },
        ),
        total: feed.total,
        totalPages: feed.totalPages,
        unreadCount,
      };
      return action.mode === 'append'
        ? { ...base, page: Math.max(state.page, feed.page), loadingMore: false }
        : { ...base, page: Math.max(state.page, 1), loadedAt: action.at };
    }

    case 'loadFailed':
      if (action.forbidden)
        return { ...state, forbidden: true, status: 'error', loadingMore: false };
      if (action.mode === 'append') return { ...state, loadingMore: false };
      return state.items.length === 0 && state.status !== 'ready'
        ? { ...state, status: 'error' }
        : { ...state, stale: true };

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
      return {
        ...state,
        unreadCount: action.unreadCount,
        countBeforeSeen: null,
        seen: state.seen === null ? null : { ...state.seen, status: 'ok' },
      };

    case 'seenFailed':
      return {
        ...state,
        unreadCount: state.countBeforeSeen ?? state.unreadCount,
        countBeforeSeen: null,
        seen: state.seen === null ? null : { ...state.seen, status: 'failed' },
      };

    case 'panelClosed': {
      const seen = state.seen;
      if (seen === null || seen.status === 'failed') return { ...state, panelOpen: false };
      const mark = new Date(seen.upTo).getTime();
      const clear = (notice: MemberAnnouncement): MemberAnnouncement =>
        notice.isNew && new Date(notice.createdAt).getTime() <= mark
          ? { ...notice, isNew: false }
          : notice;
      return {
        ...state,
        panelOpen: false,
        items: state.items.map(clear),
        pinned: state.pinned.map(clear),
      };
    }

    case 'markAllRead': {
      const clear = (notice: MemberAnnouncement): MemberAnnouncement =>
        notice.isNew ? { ...notice, isNew: false } : notice;
      // `countBeforeSeen` is left alone on purpose: it is what the mark the
      // provider sent with this restores if it fails. Clearing it left the
      // badge at 0 while the server still counted the notices unread.
      return {
        ...state,
        unreadCount: 0,
        items: state.items.map(clear),
        pinned: state.pinned.map(clear),
      };
    }

    case 'noticeInjected':
      return state.items.some((notice) => notice.id === action.notice.id)
        ? state
        : { ...state, items: mergeItems(state.items, [action.notice]) };
  }
}

/**
 * Union by id, newest first (`createdAt`, then `id`, both descending — the
 * server's `MEMBER_FEED_ORDER`). The incoming copy wins, so an edited notice
 * shows its edit; with `keepNew` a dot that was lit stays lit.
 */
export function mergeItems(
  existing: readonly MemberAnnouncement[],
  incoming: readonly MemberAnnouncement[],
  options: { keepNew?: boolean } = {},
): MemberAnnouncement[] {
  const byId = new Map(existing.map((notice) => [notice.id, notice]));
  for (const next of incoming) {
    const prev = byId.get(next.id);
    byId.set(
      next.id,
      options.keepNew === true && prev !== undefined && prev.isNew && !next.isNew
        ? { ...next, isNew: true }
        : next,
    );
  }
  return [...byId.values()].sort(byNewest);
}

function byNewest(a: MemberAnnouncement, b: MemberAnnouncement): number {
  const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  if (diff !== 0) return diff;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The `upTo` the bell sends: the createdAt of the newest notice actually SHOWN,
 * never "now" — "now" would mark as seen a notice posted between the fetch and
 * the POST, which the member never laid eyes on.
 */
export function newestCreatedAt(items: readonly MemberAnnouncement[]): string | null {
  let newest: MemberAnnouncement | null = null;
  for (const notice of items) {
    if (newest === null || new Date(notice.createdAt) > new Date(newest.createdAt)) newest = notice;
  }
  return newest === null ? null : newest.createdAt;
}

/** True when never loaded, or when the last load is at least `maxAgeMs` old. */
export function shouldRefresh(loadedAt: number | null, now: number, maxAgeMs: number): boolean {
  return loadedAt === null || now - loadedAt >= maxAgeMs;
}

/** The dashboard's list: pinned first, then everything else, nothing twice. */
export function sectionItems(
  pinned: readonly MemberAnnouncement[],
  items: readonly MemberAnnouncement[],
): MemberAnnouncement[] {
  const pinnedIds = new Set(pinned.map((notice) => notice.id));
  return [...pinned, ...items.filter((notice) => !pinnedIds.has(notice.id))];
}

/** Whether any row still shows a "new" dot — drives "Mark all read". */
export function hasNewDots(state: Pick<FeedState, 'items' | 'pinned'>): boolean {
  return state.items.some((notice) => notice.isNew) || state.pinned.some((notice) => notice.isNew);
}

export function canLoadMore(state: Pick<FeedState, 'page' | 'totalPages'>): boolean {
  return state.page < state.totalPages;
}
