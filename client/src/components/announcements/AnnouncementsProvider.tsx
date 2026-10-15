'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { MemberAnnouncement, MemberAnnouncementFeed } from '@got/shared';
import { ApiError } from '@/lib/api';
import { fetchMemberFeed, markAnnouncementsSeen } from '@/lib/announcements/api';
import {
  INITIAL_FEED,
  canLoadMore,
  feedReducer,
  mergeItems,
  newestCreatedAt,
  shouldRefresh,
  type FeedState,
} from '@/lib/announcements/feed';
import { countRose } from '@/lib/announcements/unread';
import { PORTAL_NOTICES_HOME } from '@/lib/announcements/focus';
import { markInFlight } from '@/lib/notices/feed';

/**
 * One announcements feed for the whole portal shell — the bell and the
 * dashboard read the same state, so neither fetches what the other already
 * has, and the dot on a bell row and the "New" on a dashboard notice cannot
 * disagree.
 *
 * REFRESH, NEVER POLL: on mount; when the tab becomes visible or focused and
 * the feed is over a minute old; and when the bell opens and it is over thirty
 * seconds old. A member's phone sitting on the dashboard makes no requests.
 *
 * In the member portal the bell also lists the member's own notices
 * (`MemberNoticesProvider`), so it — not this provider — decides what opening
 * it marks seen, and speaks for both feeds at once.
 */
interface AnnouncementsContextValue {
  state: FeedState;
  /**
   * The dashboard this surface reads notices on — `/portal/dashboard` in the
   * member portal, `/admin` in the console. Every `?notice=` link is built
   * against it, so a bell row never hands staff across to the portal.
   */
  noticesHome: string;
  /**
   * Bumped each time a refresh brings a higher unread count than the server
   * last reported. The bell adds it to the notices feed's and speaks once for
   * both, through its one polite status region.
   */
  rises: number;
  /**
   * Marks the dropdown open and refreshes a stale feed first; resolves with
   * the announcements the bell is about to list. Marks nothing itself: what
   * counts as SEEN depends on both feeds' rows, so the bell decides and calls
   * `markSeen`.
   */
  openPanel: () => Promise<readonly MemberAnnouncement[]>;
  closePanel: () => void;
  /** Moves the watermark to `upTo` — the newest announcement the bell SHOWED. */
  markSeen: (upTo: string) => void;
  markAllRead: () => void;
  loadMore: () => Promise<void>;
  retry: () => void;
  injectNotice: (notice: MemberAnnouncement) => void;
}

const AnnouncementsContext = createContext<AnnouncementsContextValue | null>(null);

const VISIBLE_MAX_AGE_MS = 60_000;
const OPEN_MAX_AGE_MS = 30_000;

export function AnnouncementsProvider({
  noticesHome = PORTAL_NOTICES_HOME,
  children,
}: {
  noticesHome?: string;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(feedReducer, INITIAL_FEED);
  const [rises, setRises] = useState(0);

  // The latest state for callbacks that must not be re-created on every
  // dispatch (event listeners, the bell's open handler).
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);
  const inFlight = useRef<Promise<MemberAnnouncementFeed | null> | null>(null);
  /** The unread count the server last reported; null before the first load. */
  const serverCount = useRef<number | null>(null);
  /**
   * The newest `upTo` sent, recorded the moment it is sent. Not read off
   * `latest`, which trails React's render: a guard reading that could drop the
   * very answer it is waiting for and leave the mark pending for good.
   */
  const lastSent = useRef<string | null>(null);

  const loadFirst = useCallback((): Promise<MemberAnnouncementFeed | null> => {
    // One first-page request at a time: focus and visibility fire together.
    if (inFlight.current !== null) return inFlight.current;
    dispatch({ type: 'loadStarted', mode: 'first' });
    const request = fetchMemberFeed(1)
      .then((feed) => {
        dispatch({ type: 'loaded', mode: 'first', feed, at: Date.now() });
        // Spoken only when a REFRESH brings a higher count than the server
        // last reported — never on the first load, never for the member's own
        // bell-open or "Mark all read".
        if (countRose(serverCount.current, feed.unreadCount)) setRises((n) => n + 1);
        serverCount.current = feed.unreadCount;
        return feed;
      })
      .catch((error: unknown) => {
        dispatch({
          type: 'loadFailed',
          mode: 'first',
          forbidden: error instanceof ApiError && error.status === 403,
        });
        return null;
      })
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = request;
    return request;
  }, []);

  useEffect(() => {
    void loadFirst();

    const refreshIfStale = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (latest.current.forbidden) return;
      if (shouldRefresh(latest.current.loadedAt, Date.now(), VISIBLE_MAX_AGE_MS)) void loadFirst();
    };
    document.addEventListener('visibilitychange', refreshIfStale);
    window.addEventListener('focus', refreshIfStale);
    return () => {
      document.removeEventListener('visibilitychange', refreshIfStale);
      window.removeEventListener('focus', refreshIfStale);
    };
  }, [loadFirst]);

  const markSeen = useCallback((upTo: string): void => {
    // One mark in flight at a time for the same rows. One that already landed
    // does not stop this: the watermark only moves forward, so re-marking is
    // idempotent, and it is what corrects a count the server still disagrees
    // about (see `markInFlight`).
    if (markInFlight(latest.current.seen, upTo)) return;
    lastSent.current = upTo;
    dispatch({ type: 'seenRequested', upTo });
    markAnnouncementsSeen(upTo)
      .then((result) => {
        serverCount.current = result.unreadCount;
        // An answer for an older mark must not settle a newer one still in
        // flight: its recount predates that mark and would flash the badge.
        if (lastSent.current === upTo) {
          dispatch({ type: 'seenSucceeded', unreadCount: result.unreadCount });
        }
      })
      .catch(() => {
        if (lastSent.current === upTo) dispatch({ type: 'seenFailed' });
      });
  }, []);

  const openPanel = useCallback((): Promise<readonly MemberAnnouncement[]> => {
    dispatch({ type: 'panelOpened' });
    const current = latest.current;
    // A 403 is this account's answer, not a blip: asking again on every open
    // would only repeat it (and nudge MeProvider into refetching /me).
    if (current.forbidden || !shouldRefresh(current.loadedAt, Date.now(), OPEN_MAX_AGE_MS)) {
      return Promise.resolve(current.items);
    }
    // Refresh first when stale, so the mark is the newest notice the member
    // is about to SEE — never one from a list they are not looking at. Page
    // one IS the newest notices, so merging the fresh response into what is
    // loaded names the rows the reducer is about to hold — no need to wait for
    // React to fold it into state. A failed refresh leaves the old rows on
    // screen, and those are the rows.
    return loadFirst().then((feed) =>
      feed === null ? latest.current.items : mergeItems(latest.current.items, feed.items),
    );
  }, [loadFirst]);

  const closePanel = useCallback((): void => dispatch({ type: 'panelClosed' }), []);

  const markAllRead = useCallback((): void => {
    // Opening the bell moved the watermark to the newest announcement it
    // SHOWED; this covers everything loaded — including rows the member's own
    // notices pushed below the bell's cut — and clears the dots now. If that
    // POST failed, this is the retry.
    const upTo = newestCreatedAt(latest.current.items);
    if (upTo !== null) markSeen(upTo);
    dispatch({ type: 'markAllRead' });
  }, [markSeen]);

  const loadMore = useCallback(async (): Promise<void> => {
    const current = latest.current;
    if (current.loadingMore || !canLoadMore(current)) return;
    dispatch({ type: 'loadStarted', mode: 'append' });
    try {
      const feed = await fetchMemberFeed(current.page + 1);
      dispatch({ type: 'loaded', mode: 'append', feed, at: Date.now() });
    } catch (error) {
      dispatch({
        type: 'loadFailed',
        mode: 'append',
        forbidden: error instanceof ApiError && error.status === 403,
      });
    }
  }, []);

  const retry = useCallback((): void => void loadFirst(), [loadFirst]);

  const injectNotice = useCallback(
    (notice: MemberAnnouncement): void => dispatch({ type: 'noticeInjected', notice }),
    [],
  );

  const value = useMemo<AnnouncementsContextValue>(
    () => ({
      state,
      noticesHome,
      rises,
      openPanel,
      closePanel,
      markSeen,
      markAllRead,
      loadMore,
      retry,
      injectNotice,
    }),
    [
      state,
      noticesHome,
      rises,
      openPanel,
      closePanel,
      markSeen,
      markAllRead,
      loadMore,
      retry,
      injectNotice,
    ],
  );

  return <AnnouncementsContext.Provider value={value}>{children}</AnnouncementsContext.Provider>;
}

export function useAnnouncements(): AnnouncementsContextValue {
  const value = useContext(AnnouncementsContext);
  if (value === null) {
    throw new Error('useAnnouncements must be used inside <AnnouncementsProvider>');
  }
  return value;
}
