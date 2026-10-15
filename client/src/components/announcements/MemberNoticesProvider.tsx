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
import type { MemberNoticeFeedWire, MemberNoticeWire } from '@got/shared';
import { ApiError } from '@/lib/api';
import { shouldRefresh } from '@/lib/announcements/feed';
import { countRose } from '@/lib/announcements/unread';
import { fetchMyNotices, markNoticesSeen } from '@/lib/notices/api';
import {
  INITIAL_NOTICE_FEED,
  markInFlight,
  newestNoticeAt,
  noticeFeedReducer,
  noticesNewestFirst,
  type NoticeFeedState,
} from '@/lib/notices/feed';

/**
 * The member's own notices — the personal half of the portal bell, beside
 * `AnnouncementsProvider` and shaped like it, over `GET /me/notices`.
 *
 * REFRESH, NEVER POLL — the announcements feed's rules exactly: on mount; when
 * the tab becomes visible or focused and the feed is over a minute old; and
 * when the bell opens and it is over thirty seconds old. A phone left on a
 * page makes no requests.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * OPTIONAL BY DESIGN. Only the member portal mounts this. The console mounts
 * the same `NotificationBell` with announcements alone, so the bell reads it
 * through `useMemberNoticesOptional()`, which answers null outside the
 * provider instead of throwing the way `useAnnouncements` does. A throwing
 * hook here would take the console's topbar down with it.
 * ═════════════════════════════════════════════════════════════════════════
 */
export interface MemberNoticesContextValue {
  state: NoticeFeedState;
  /**
   * Bumped each time a refresh brings a higher unread count than the server
   * last reported. The bell adds it to the announcements feed's and speaks
   * once for both (`countRose`).
   */
  rises: number;
  /**
   * Marks the dropdown open and refreshes a stale feed first; resolves with
   * the notices the bell is about to list. Marks nothing itself: what counts
   * as SEEN depends on both feeds' rows, so the bell decides and calls
   * `markSeen`.
   */
  openPanel: () => Promise<readonly MemberNoticeWire[]>;
  closePanel: () => void;
  /** Marks read every notice up to `upTo` — the newest one the bell SHOWED. */
  markSeen: (upTo: string) => void;
  /** Clears every dot and the count, marking up to the newest notice loaded. */
  markAllRead: () => void;
  retry: () => void;
}

const MemberNoticesContext = createContext<MemberNoticesContextValue | null>(null);

const VISIBLE_MAX_AGE_MS = 60_000;
const OPEN_MAX_AGE_MS = 30_000;

export function MemberNoticesProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(noticeFeedReducer, INITIAL_NOTICE_FEED);
  const [rises, setRises] = useState(0);

  // The latest state for callbacks that must not be re-created on every
  // dispatch (event listeners, the bell's open handler).
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);
  const inFlight = useRef<Promise<MemberNoticeFeedWire | null> | null>(null);
  /** The unread count the server last reported; null before the first load. */
  const serverCount = useRef<number | null>(null);

  const loadFirst = useCallback((): Promise<MemberNoticeFeedWire | null> => {
    // One request at a time: focus and visibility fire together.
    if (inFlight.current !== null) return inFlight.current;
    dispatch({ type: 'loadStarted' });
    const request = fetchMyNotices(1)
      .then((feed) => {
        dispatch({ type: 'loaded', feed, at: Date.now() });
        if (countRose(serverCount.current, feed.unreadCount)) setRises((n) => n + 1);
        serverCount.current = feed.unreadCount;
        return feed;
      })
      .catch((error: unknown) => {
        dispatch({
          type: 'loadFailed',
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
    // does not stop this: re-marking is idempotent, and it is what corrects a
    // count the server still disagrees about (see `markInFlight`).
    if (markInFlight(latest.current.seen, upTo)) return;
    dispatch({ type: 'seenRequested', upTo });
    markNoticesSeen(upTo)
      .then((result) => {
        serverCount.current = result.unreadCount;
        dispatch({ type: 'seenSucceeded', upTo, unreadCount: result.unreadCount });
      })
      .catch(() => dispatch({ type: 'seenFailed', upTo }));
  }, []);

  const openPanel = useCallback((): Promise<readonly MemberNoticeWire[]> => {
    dispatch({ type: 'panelOpened' });
    const current = latest.current;
    // A 403 is this account's answer, not a blip: asking again on every open
    // would only repeat it (and nudge MeProvider into refetching /me).
    if (current.forbidden || !shouldRefresh(current.loadedAt, Date.now(), OPEN_MAX_AGE_MS)) {
      return Promise.resolve(current.items);
    }
    // Refresh first when stale, so the mark is the newest notice the member
    // is about to SEE. Page one IS the newest, so the fresh response alone
    // names the rows — no need to wait for React to fold it into state. A
    // failed refresh leaves the old rows on screen, and those are the rows.
    return loadFirst().then((feed) =>
      feed === null ? latest.current.items : noticesNewestFirst(feed.items),
    );
  }, [loadFirst]);

  const closePanel = useCallback((): void => dispatch({ type: 'panelClosed' }), []);

  const markAllRead = useCallback((): void => {
    // Opening the bell marked what it showed; this covers the rest of what is
    // loaded — including rows the other feed pushed below the cut. If an
    // earlier mark failed, this is its retry.
    const upTo = newestNoticeAt(latest.current.items);
    if (upTo !== null) markSeen(upTo);
    dispatch({ type: 'markAllRead' });
  }, [markSeen]);

  const retry = useCallback((): void => void loadFirst(), [loadFirst]);

  const value = useMemo<MemberNoticesContextValue>(
    () => ({ state, rises, openPanel, closePanel, markSeen, markAllRead, retry }),
    [state, rises, openPanel, closePanel, markSeen, markAllRead, retry],
  );

  return <MemberNoticesContext.Provider value={value}>{children}</MemberNoticesContext.Provider>;
}

/**
 * The member's notices, or null where no `MemberNoticesProvider` is mounted
 * (the console). Never throws — see the banner above.
 */
export function useMemberNoticesOptional(): MemberNoticesContextValue | null {
  return useContext(MemberNoticesContext);
}
