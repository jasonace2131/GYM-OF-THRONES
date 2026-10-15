'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface AdminQuery<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * One fetch, with the three states every CRM screen needs and the two hazards
 * every hand-rolled version gets wrong.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 1. STALE RESPONSES ARE DROPPED, not rendered.
 *
 * A staffer typing in the search box fires a request per keystroke, and those
 * responses come back out of order. Without a sequence guard the table settles
 * on whichever request happened to be slowest — showing results for "ma" while
 * the box reads "maria". Every screen here is a filter over a list, so this is
 * the normal case rather than an edge one.
 *
 * 2. THE PREVIOUS DATA STAYS ON SCREEN WHILE A REFETCH IS IN FLIGHT.
 *
 * Blanking the table on every keystroke makes the whole screen strobe. The
 * `loading` flag is for the FIRST load; after that the old rows stay put and
 * are replaced in one paint.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `deps` is a serialised key rather than an array so a caller cannot
 * accidentally pass a fresh object literal and refetch forever.
 */
export interface AdminQueryOptions {
  /**
   * Re-run the same fetch every `pollMs` milliseconds.
   *
   * Polling lives HERE rather than beside the hook because the two hazards
   * documented above are exactly the ones a poll triggers constantly: a poll
   * that lands after a newer request must not write, and a poll must not blank
   * the table it is refreshing. The sequence guard already handles both, so
   * putting the interval anywhere else would mean reimplementing them.
   *
   * Omit it for anything that does not change within a shift. A 90-day
   * membership scan on a 30-second timer is 2,880 pointless requests a day.
   */
  pollMs?: number;

  /**
   * Skip the fetch entirely. Defaults to true.
   *
   * For a panel the caller has no permission to see. A hook cannot be called
   * conditionally, so the alternative is firing a request that is guaranteed
   * to 403 and then hiding the result — which spends a round trip per panel
   * per poll to render nothing, and fills the server log with denials that
   * look like an attack rather than a UI that asked for too much.
   *
   * `loading` is false while disabled, so a `DataState` above it settles on
   * empty rather than spinning forever.
   */
  enabled?: boolean;
}

export function useAdminQuery<T>(
  fetcher: () => Promise<T>,
  key: string,
  options: AdminQueryOptions = {},
): AdminQuery<T> {
  const { pollMs, enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  // Monotonic: only the newest request may write.
  const sequenceRef = useRef(0);
  // Read inside `run` so a poll can tell a first load from a refresh without
  // taking `data` as an effect dependency and restarting its own interval.
  const hasDataRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      // Nothing in flight and nothing to wait for. Cleared rather than left at
      // its previous value so a permission that goes away takes its data with
      // it instead of leaving a stale panel on screen.
      setLoading(false);
      setData(null);
      setError(null);
      return;
    }

    let cancelled = false;

    const run = async (): Promise<void> => {
      // Each run claims its own sequence, so a poll that overtakes a slower
      // in-flight request wins and the slow one is discarded rather than
      // overwriting fresher data.
      const sequence = (sequenceRef.current += 1);
      try {
        const result = await fetcherRef.current();
        if (cancelled || sequence !== sequenceRef.current) return;
        setData(result);
        hasDataRef.current = true;
        setError(null);
      } catch (caught) {
        if (cancelled || sequence !== sequenceRef.current) return;

        // A FAILED POLL MUST NOT BLANK A PANEL THAT IS ALREADY SHOWING DATA.
        // `DataState` renders the error branch instead of its children, so
        // surfacing a transient refresh failure would replace a correct table
        // with an error card — and the next poll would replace it back. Stale
        // data that was right sixty seconds ago beats an error box that
        // flickers. First load has nothing to keep, so it still reports.
        if (hasDataRef.current) return;

        setError(
          caught instanceof ApiError
            ? // A 403 here means the grant table disagrees with the nav, which
              // is worth saying plainly rather than rendering as "no results".
              caught.status === 403
              ? 'Your account does not have access to this.'
              : caught.message
            : 'Something went wrong.',
        );
      } finally {
        if (!cancelled && sequence === sequenceRef.current) setLoading(false);
      }
    };

    // Deferred by a tick so the effect never sets state during its own commit.
    const id = window.setTimeout(() => void run(), 0);

    if (pollMs === undefined) {
      return () => {
        cancelled = true;
        window.clearTimeout(id);
      };
    }

    // A HIDDEN TAB DOES NOT POLL. A console left open on a back-office monitor
    // overnight would otherwise spend thousands of requests refreshing a
    // screen nobody is looking at, and arrive in the morning with data that is
    // no fresher than one immediate fetch would have produced.
    const tick = (): void => {
      if (document.visibilityState === 'visible') void run();
    };
    const interval = window.setInterval(tick, pollMs);

    // Coming back to the tab refetches at once rather than waiting out the
    // remainder of an interval that elapsed while it was hidden.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.clearTimeout(id);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, nonce, pollMs, enabled]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading: enabled && loading && data === null, error, reload };
}

/**
 * A value that lags its input, so a keystroke does not become a request.
 *
 * 300 ms: long enough that ordinary typing produces one request per pause,
 * short enough that a staffer who types a member code and stops does not
 * notice a wait.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);

  return settled;
}
