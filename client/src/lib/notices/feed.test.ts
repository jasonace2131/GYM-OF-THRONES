import { describe, expect, it } from 'vitest';
import type { MemberNoticeFeedWire, MemberNoticeWire } from '@got/shared';
import {
  INITIAL_NOTICE_FEED,
  compareNewest,
  hasNewNotices,
  markInFlight,
  newestNoticeAt,
  noticeFeedReducer,
  noticesNewestFirst,
  type NoticeFeedState,
} from './feed';

function notice(
  id: string,
  createdAt: string,
  over: Partial<MemberNoticeWire> = {},
): MemberNoticeWire {
  return {
    id,
    kind: 'CLASS_PROMOTED',
    title: `You're in: Yoga (${id})`,
    body: null,
    linkPath: '/portal/book?date=2026-10-14',
    isNew: false,
    createdAt,
    ...over,
  };
}

const N3 = notice('n3', '2026-10-11T03:00:00.000Z', { isNew: true });
const N2 = notice('n2', '2026-10-10T03:00:00.000Z', { isNew: true });
const N1 = notice('n1', '2026-10-01T03:00:00.000Z');

function page(
  items: MemberNoticeWire[],
  over: Partial<MemberNoticeFeedWire> = {},
): MemberNoticeFeedWire {
  return { items, total: 3, page: 1, limit: 10, totalPages: 1, unreadCount: 2, ...over };
}

function ready(over: Partial<NoticeFeedState> = {}): NoticeFeedState {
  return noticeFeedReducer(
    { ...INITIAL_NOTICE_FEED, ...over },
    { type: 'loaded', feed: page([N3, N2, N1]), at: 1000 },
  );
}

const ids = (items: readonly MemberNoticeWire[]): string[] => items.map((item) => item.id);
const lit = (state: NoticeFeedState): string[] => ids(state.items.filter((item) => item.isNew));

describe('noticeFeedReducer — loading', () => {
  it('shows loading only when there is nothing on screen yet', () => {
    expect(noticeFeedReducer(INITIAL_NOTICE_FEED, { type: 'loadStarted' }).status).toBe('loading');
    // A background refresh must not flash the skeleton over real rows.
    expect(noticeFeedReducer(ready(), { type: 'loadStarted' }).status).toBe('ready');
  });

  it('takes page one newest first, with its count and the time', () => {
    const state = noticeFeedReducer(INITIAL_NOTICE_FEED, {
      type: 'loaded',
      // Out of order on purpose: the list is the bell's order, whatever arrives.
      feed: page([N1, N3, N2]),
      at: 1000,
    });
    expect(state.status).toBe('ready');
    expect(ids(state.items)).toEqual(['n3', 'n2', 'n1']);
    expect(state).toMatchObject({ unreadCount: 2, loadedAt: 1000, stale: false });
  });

  /** Page one only: a notice that left page one leaves the bell with it. */
  it('replaces the list on a refresh rather than merging into it', () => {
    const fresh = notice('n4', '2026-10-11T05:00:00.000Z', { isNew: true });
    const state = noticeFeedReducer(ready(), {
      type: 'loaded',
      feed: page([fresh, N3, N2], { unreadCount: 3 }),
      at: 2000,
    });
    expect(ids(state.items)).toEqual(['n4', 'n3', 'n2']);
    expect(state.unreadCount).toBe(3);
    expect(state.loadedAt).toBe(2000);
  });

  it('drops the feed from the bell on 403', () => {
    const state = noticeFeedReducer(INITIAL_NOTICE_FEED, { type: 'loadFailed', forbidden: true });
    expect(state.forbidden).toBe(true);
  });

  it('errors with no data, and keeps data (marked stale) when a refresh fails', () => {
    expect(
      noticeFeedReducer(INITIAL_NOTICE_FEED, { type: 'loadFailed', forbidden: false }).status,
    ).toBe('error');

    const state = noticeFeedReducer(ready(), { type: 'loadFailed', forbidden: false });
    expect(state.status).toBe('ready');
    expect(state.stale).toBe(true);
    expect(state.items).toHaveLength(3);
  });
});

describe('noticeFeedReducer — the bell', () => {
  it('zeroes the count optimistically on seenRequested and keeps the dots', () => {
    const open = noticeFeedReducer(ready(), { type: 'panelOpened' });
    const state = noticeFeedReducer(open, { type: 'seenRequested', upTo: N3.createdAt });

    expect(state.unreadCount).toBe(0);
    expect(lit(state)).toEqual(['n3', 'n2']);
    expect(state.seen).toEqual({ upTo: N3.createdAt, status: 'pending' });
  });

  it('restores the count when the seen POST fails', () => {
    const pending = noticeFeedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N3.createdAt,
    });
    const state = noticeFeedReducer(pending, { type: 'seenFailed', upTo: N3.createdAt });
    expect(state.unreadCount).toBe(2);
    expect(state.seen?.status).toBe('failed');
  });

  it("takes the server's count when the seen POST lands", () => {
    const pending = noticeFeedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N3.createdAt,
    });
    const state = noticeFeedReducer(pending, {
      type: 'seenSucceeded',
      upTo: N3.createdAt,
      unreadCount: 0,
    });
    expect(state.unreadCount).toBe(0);
    expect(state.seen?.status).toBe('ok');
    expect(state.countBeforeSeen).toBeNull();
  });

  /** The in-flight rule: the combined badge must not flash back to its old value. */
  it('does not let a refresh resurrect the count while seen is pending', () => {
    const pending = noticeFeedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N3.createdAt,
    });
    const state = noticeFeedReducer(pending, {
      type: 'loaded',
      feed: page([N3, N2, N1], { unreadCount: 2 }),
      at: 6000,
    });
    expect(state.unreadCount).toBe(0);
  });

  /** If the mark then fails, the fresher server count is the one to put back. */
  it('falls back to the count a pending-time refresh reported', () => {
    const fresh = notice('n4', '2026-10-11T05:00:00.000Z', { isNew: true });
    let state = noticeFeedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N3.createdAt,
    });
    state = noticeFeedReducer(state, {
      type: 'loaded',
      feed: page([fresh, N3, N2], { unreadCount: 3 }),
      at: 6000,
    });
    state = noticeFeedReducer(state, { type: 'seenFailed', upTo: N3.createdAt });
    expect(state.unreadCount).toBe(3);
  });

  /** Items stay visibly "new" while the dropdown is open — owner decision. */
  it('keeps a lit dot lit while the panel is open', () => {
    const open = noticeFeedReducer(ready(), { type: 'panelOpened' });
    const seenNow = page([{ ...N3, isNew: false }, { ...N2, isNew: false }, N1], {
      unreadCount: 0,
    });
    const state = noticeFeedReducer(open, { type: 'loaded', feed: seenNow, at: 5000 });
    expect(lit(state)).toEqual(['n3', 'n2']);
  });

  it("takes the server's isNew when the panel is closed", () => {
    const seenNow = page([{ ...N3, isNew: false }, { ...N2, isNew: false }, N1], {
      unreadCount: 0,
    });
    const state = noticeFeedReducer(ready(), { type: 'loaded', feed: seenNow, at: 5000 });
    expect(hasNewNotices(state)).toBe(false);
  });

  /**
   * A GET the server answered just before the seen POST still calls those rows
   * new. Believing it would relight dots the member already cleared.
   */
  it('keeps rows at or before a live mark read on a refresh after the panel closed', () => {
    const fresh = notice('n4', '2026-10-11T05:00:00.000Z', { isNew: true });
    let state = noticeFeedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N3.createdAt,
    });
    state = noticeFeedReducer(state, { type: 'panelClosed' });
    state = noticeFeedReducer(state, {
      type: 'loaded',
      feed: page([fresh, N3, N2, N1], { unreadCount: 3 }),
      at: 7000,
    });
    expect(lit(state)).toEqual(['n4']);
  });

  it('clears the dots it marked seen when the panel closes, and only those', () => {
    const fresh = notice('n4', '2026-10-11T05:00:00.000Z', { isNew: true });
    let state = noticeFeedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N3.createdAt,
    });
    state = noticeFeedReducer(state, {
      type: 'seenSucceeded',
      upTo: N3.createdAt,
      unreadCount: 1,
    });
    // A notice newer than the mark arrived while the panel was open.
    state = noticeFeedReducer(state, {
      type: 'loaded',
      feed: page([fresh, N3, N2, N1], { unreadCount: 1 }),
      at: 8000,
    });

    state = noticeFeedReducer(state, { type: 'panelClosed' });

    expect(state.panelOpen).toBe(false);
    expect(lit(state)).toEqual(['n4']);
  });

  it('keeps the dots when the seen POST failed', () => {
    let state = noticeFeedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N3.createdAt,
    });
    state = noticeFeedReducer(state, { type: 'seenFailed', upTo: N3.createdAt });
    state = noticeFeedReducer(state, { type: 'panelClosed' });
    expect(lit(state)).toEqual(['n3', 'n2']);
  });

  it('clears every dot and the count on markAllRead', () => {
    const state = noticeFeedReducer(ready(), { type: 'markAllRead' });
    expect(hasNewNotices(state)).toBe(false);
    expect(state.unreadCount).toBe(0);
  });

  /** The member pressed "Mark all read" and it did not land: the count says so. */
  it('brings the count back when the mark sent with markAllRead fails', () => {
    let state = noticeFeedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N3.createdAt,
    });
    state = noticeFeedReducer(state, { type: 'markAllRead' });
    state = noticeFeedReducer(state, { type: 'seenFailed', upTo: N3.createdAt });
    expect(state.unreadCount).toBe(2);
  });
});

describe('noticeFeedReducer — a late answer to an older mark', () => {
  const OLD = N2.createdAt;
  const NEW = N3.createdAt;

  function twoMarks(): NoticeFeedState {
    let state = noticeFeedReducer(ready({ panelOpen: true }), { type: 'seenRequested', upTo: OLD });
    state = noticeFeedReducer(state, { type: 'seenRequested', upTo: NEW });
    return state;
  }

  it('keeps the count from before the FIRST mark when a second is sent', () => {
    expect(twoMarks().countBeforeSeen).toBe(2);
  });

  it('does not let it settle the newer mark or move the badge', () => {
    const state = noticeFeedReducer(twoMarks(), {
      type: 'seenSucceeded',
      upTo: OLD,
      unreadCount: 1,
    });
    expect(state.seen).toEqual({ upTo: NEW, status: 'pending' });
    expect(state.unreadCount).toBe(0);
    // …but it is the server's latest word if the newer mark fails.
    expect(noticeFeedReducer(state, { type: 'seenFailed', upTo: NEW }).unreadCount).toBe(1);
  });

  it('ignores its failure', () => {
    const state = noticeFeedReducer(twoMarks(), { type: 'seenFailed', upTo: OLD });
    expect(state.seen).toEqual({ upTo: NEW, status: 'pending' });
    expect(state.unreadCount).toBe(0);
  });
});

describe('helpers', () => {
  it('compareNewest orders by createdAt, then id, both descending', () => {
    const a = notice('a', '2026-10-01T00:00:00.000Z');
    const b = notice('b', '2026-10-01T00:00:00.000Z');
    expect(ids(noticesNewestFirst([a, N3, b]))).toEqual(['n3', 'b', 'a']);
    expect(compareNewest(a, a)).toBe(0);
  });

  it('newestNoticeAt is the latest instant, or null', () => {
    expect(newestNoticeAt([N1, N3, N2])).toBe(N3.createdAt);
    expect(newestNoticeAt([])).toBeNull();
  });

  it('markInFlight only for a pending mark at or past the one asked for', () => {
    expect(markInFlight(null, N3.createdAt)).toBe(false);
    expect(markInFlight({ upTo: N3.createdAt, status: 'pending' }, N3.createdAt)).toBe(true);
    expect(markInFlight({ upTo: N3.createdAt, status: 'pending' }, N2.createdAt)).toBe(true);
    expect(markInFlight({ upTo: N2.createdAt, status: 'pending' }, N3.createdAt)).toBe(false);
    expect(markInFlight({ upTo: N3.createdAt, status: 'failed' }, N3.createdAt)).toBe(false);
  });

  /**
   * A mark that landed never suppresses the next: re-marking is idempotent, and
   * it is the only thing that clears a count the server still disagrees about.
   */
  it('does not treat a landed mark as covering anything', () => {
    expect(markInFlight({ upTo: N3.createdAt, status: 'ok' }, N2.createdAt)).toBe(false);
    expect(markInFlight({ upTo: N3.createdAt, status: 'ok' }, N3.createdAt)).toBe(false);
  });
});
