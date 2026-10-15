import { describe, expect, it } from 'vitest';
import type { MemberAnnouncement, MemberAnnouncementFeed } from '@got/shared';
import {
  INITIAL_FEED,
  canLoadMore,
  feedReducer,
  hasNewDots,
  mergeItems,
  newestCreatedAt,
  sectionItems,
  shouldRefresh,
  type FeedState,
} from './feed';

function notice(
  id: string,
  createdAt: string,
  over: Partial<MemberAnnouncement> = {},
): MemberAnnouncement {
  return {
    id,
    title: `Notice ${id}`,
    content: 'Body',
    contentJson: null,
    coverImageUrl: null,
    isPinned: false,
    author: { id: 'a1', firstName: 'Ana', lastName: 'Cruz' },
    createdAt,
    updatedAt: createdAt,
    isNew: false,
    ...over,
  };
}

const N3 = notice('n3', '2026-09-24T03:00:00.000Z', { isNew: true });
const N2 = notice('n2', '2026-09-23T03:00:00.000Z', { isNew: true });
const N1 = notice('n1', '2026-09-10T03:00:00.000Z');
const P1 = notice('p1', '2026-08-01T03:00:00.000Z', { isPinned: true });

function page(
  items: MemberAnnouncement[],
  over: Partial<MemberAnnouncementFeed> = {},
): MemberAnnouncementFeed {
  return {
    items,
    total: 23,
    page: 1,
    limit: 10,
    totalPages: 3,
    pinned: [P1],
    unreadCount: 2,
    ...over,
  };
}

function ready(over: Partial<FeedState> = {}): FeedState {
  return feedReducer(
    { ...INITIAL_FEED, ...over },
    { type: 'loaded', mode: 'first', feed: page([N3, N2, N1]), at: 1000 },
  );
}

describe('feedReducer — loading', () => {
  it('shows loading only when there is nothing on screen yet', () => {
    expect(feedReducer(INITIAL_FEED, { type: 'loadStarted', mode: 'first' }).status).toBe(
      'loading',
    );
    // A background refresh must not flash the skeleton over real notices.
    expect(feedReducer(ready(), { type: 'loadStarted', mode: 'first' }).status).toBe('ready');
  });

  it('takes the first page, the pinned strip, the counts and the time', () => {
    const state = ready();
    expect(state.status).toBe('ready');
    expect(state.items.map((item) => item.id)).toEqual(['n3', 'n2', 'n1']);
    expect(state.pinned.map((item) => item.id)).toEqual(['p1']);
    expect(state).toMatchObject({
      total: 23,
      totalPages: 3,
      page: 1,
      unreadCount: 2,
      loadedAt: 1000,
    });
  });

  it('appends the next page, deduped and in order', () => {
    const more = notice('n0', '2026-09-01T03:00:00.000Z');
    const loading = feedReducer(ready(), { type: 'loadStarted', mode: 'append' });
    expect(loading.loadingMore).toBe(true);

    const state = feedReducer(loading, {
      type: 'loaded',
      mode: 'append',
      // n1 repeats — a notice posted between the two pages shifts the offset.
      feed: page([N1, more], { page: 2 }),
      at: 2000,
    });

    expect(state.items.map((item) => item.id)).toEqual(['n3', 'n2', 'n1', 'n0']);
    expect(state.page).toBe(2);
    expect(state.loadingMore).toBe(false);
  });

  it('keeps later pages when page one is refreshed', () => {
    const more = notice('n0', '2026-09-01T03:00:00.000Z');
    const two = feedReducer(ready(), {
      type: 'loaded',
      mode: 'append',
      feed: page([more], { page: 2 }),
      at: 2000,
    });
    const fresh = notice('n4', '2026-09-24T05:00:00.000Z', { isNew: true });

    const state = feedReducer(two, {
      type: 'loaded',
      mode: 'first',
      feed: page([fresh, N3, N2], { unreadCount: 3 }),
      at: 3000,
    });

    expect(state.items.map((item) => item.id)).toEqual(['n4', 'n3', 'n2', 'n1', 'n0']);
    expect(state.page).toBe(2);
    expect(state.unreadCount).toBe(3);
  });

  it('hides the bell on 403', () => {
    const state = feedReducer(INITIAL_FEED, { type: 'loadFailed', mode: 'first', forbidden: true });
    expect(state.forbidden).toBe(true);
  });

  it('errors with no data, and keeps data (marked stale) when a refresh fails', () => {
    expect(
      feedReducer(INITIAL_FEED, { type: 'loadFailed', mode: 'first', forbidden: false }).status,
    ).toBe('error');

    const state = feedReducer(ready(), { type: 'loadFailed', mode: 'first', forbidden: false });
    expect(state.status).toBe('ready');
    expect(state.stale).toBe(true);
    expect(state.items).toHaveLength(3);
  });

  it('stops the more-spinner when a page fails', () => {
    const loading = feedReducer(ready(), { type: 'loadStarted', mode: 'append' });
    const state = feedReducer(loading, { type: 'loadFailed', mode: 'append', forbidden: false });
    expect(state.loadingMore).toBe(false);
  });
});

describe('feedReducer — the bell', () => {
  it('zeroes the count optimistically on seenRequested and keeps the dots', () => {
    const open = feedReducer(ready(), { type: 'panelOpened' });
    const state = feedReducer(open, { type: 'seenRequested', upTo: N3.createdAt });

    expect(state.unreadCount).toBe(0);
    expect(state.items.filter((item) => item.isNew).map((item) => item.id)).toEqual(['n3', 'n2']);
    expect(state.seen).toEqual({ upTo: N3.createdAt, status: 'pending' });
  });

  it('restores the count when the seen POST fails', () => {
    const pending = feedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N3.createdAt,
    });
    const state = feedReducer(pending, { type: 'seenFailed' });
    expect(state.unreadCount).toBe(2);
    expect(state.seen?.status).toBe('failed');
  });

  it("takes the server's count when the seen POST lands", () => {
    const pending = feedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N3.createdAt,
    });
    const state = feedReducer(pending, { type: 'seenSucceeded', unreadCount: 0 });
    expect(state.unreadCount).toBe(0);
    expect(state.seen?.status).toBe('ok');
  });

  /** Items stay visibly "new" while the dropdown is open — owner decision. */
  it('keeps isNew = incoming || prev while the panel is open', () => {
    const open = feedReducer(ready(), { type: 'panelOpened' });
    const seenNow = page([{ ...N3, isNew: false }, { ...N2, isNew: false }, N1], {
      unreadCount: 0,
    });

    const state = feedReducer(open, { type: 'loaded', mode: 'first', feed: seenNow, at: 5000 });

    expect(state.items.filter((item) => item.isNew).map((item) => item.id)).toEqual(['n3', 'n2']);
  });

  it("takes the server's isNew when the panel is closed", () => {
    const seenNow = page([{ ...N3, isNew: false }, { ...N2, isNew: false }, N1], {
      unreadCount: 0,
    });
    const state = feedReducer(ready(), { type: 'loaded', mode: 'first', feed: seenNow, at: 5000 });
    expect(hasNewDots(state)).toBe(false);
  });

  it('does not let a refresh resurrect the count while seen is pending', () => {
    const pending = feedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N3.createdAt,
    });
    const state = feedReducer(pending, {
      type: 'loaded',
      mode: 'first',
      feed: page([N3, N2, N1], { unreadCount: 2 }),
      at: 6000,
    });
    expect(state.unreadCount).toBe(0);
  });

  it('clears the dots it marked seen when the panel closes', () => {
    const fresh = notice('n4', '2026-09-24T05:00:00.000Z', { isNew: true });
    let state = feedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N3.createdAt,
    });
    state = feedReducer(state, { type: 'seenSucceeded', unreadCount: 0 });
    // A notice newer than the mark arrived while the panel was open.
    state = feedReducer(state, { type: 'noticeInjected', notice: fresh });

    state = feedReducer(state, { type: 'panelClosed' });

    expect(state.panelOpen).toBe(false);
    expect(state.items.filter((item) => item.isNew).map((item) => item.id)).toEqual(['n4']);
  });

  it('keeps the dots when the seen POST failed', () => {
    let state = feedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N3.createdAt,
    });
    state = feedReducer(state, { type: 'seenFailed' });
    state = feedReducer(state, { type: 'panelClosed' });
    expect(state.items.filter((item) => item.isNew)).toHaveLength(2);
  });

  /**
   * "Mark all read" sends the mark and clears the count at once. When that
   * mark fails the server still counts the notices unread, so the badge must
   * come back — it used to stay at 0, because markAllRead threw away the
   * count to restore.
   */
  it('restores the pre-mark count when the mark sent with markAllRead fails', () => {
    let state = feedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N3.createdAt,
    });
    state = feedReducer(state, { type: 'markAllRead' });
    expect(state.unreadCount).toBe(0);

    state = feedReducer(state, { type: 'seenFailed' });
    expect(state.unreadCount).toBe(2);
    expect(state.seen?.status).toBe('failed');
  });

  it('a second mark while the first is in flight keeps the count from before the first', () => {
    let state = feedReducer(ready({ panelOpen: true }), {
      type: 'seenRequested',
      upTo: N2.createdAt,
    });
    state = feedReducer(state, { type: 'seenRequested', upTo: N3.createdAt });
    expect(state.unreadCount).toBe(0);

    state = feedReducer(state, { type: 'seenFailed' });
    expect(state.unreadCount).toBe(2);
  });

  it('clears every dot and the count on markAllRead', () => {
    const withNewPin = ready();
    const state = feedReducer(
      { ...withNewPin, pinned: [{ ...P1, isNew: true }] },
      { type: 'markAllRead' },
    );
    expect(hasNewDots(state)).toBe(false);
    expect(state.unreadCount).toBe(0);
  });
});

describe('feedReducer — deep link', () => {
  it('injects a notice beyond the loaded pages, in order, once', () => {
    const old = notice('n-old', '2026-06-01T03:00:00.000Z');
    let state = feedReducer(ready(), { type: 'noticeInjected', notice: old });
    state = feedReducer(state, { type: 'noticeInjected', notice: old });
    expect(state.items.map((item) => item.id)).toEqual(['n3', 'n2', 'n1', 'n-old']);
  });
});

describe('helpers', () => {
  it('mergeItems dedupes by id, lets the incoming copy win, and sorts newest first', () => {
    const edited = { ...N2, title: 'Edited' };
    const merged = mergeItems([N1, N2], [edited, N3]);
    expect(merged.map((item) => item.id)).toEqual(['n3', 'n2', 'n1']);
    expect(merged[1]?.title).toBe('Edited');
  });

  it('mergeItems breaks createdAt ties by id, descending', () => {
    const a = notice('a', '2026-09-01T00:00:00.000Z');
    const b = notice('b', '2026-09-01T00:00:00.000Z');
    expect(mergeItems([a], [b]).map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('mergeItems keeps a dot with keepNew', () => {
    const merged = mergeItems([N3], [{ ...N3, isNew: false }], { keepNew: true });
    expect(merged[0]?.isNew).toBe(true);
  });

  it('newestCreatedAt is the latest instant, or null', () => {
    expect(newestCreatedAt([N1, N3, N2])).toBe(N3.createdAt);
    expect(newestCreatedAt([])).toBeNull();
  });

  it('shouldRefresh when never loaded, or at the age limit', () => {
    expect(shouldRefresh(null, 5_000, 60_000)).toBe(true);
    expect(shouldRefresh(0, 59_999, 60_000)).toBe(false);
    expect(shouldRefresh(0, 60_000, 60_000)).toBe(true);
  });

  it('sectionItems leads with pinned and does not repeat them', () => {
    const pinnedRecent = { ...N2, isPinned: true };
    const list = sectionItems([pinnedRecent, P1], [N3, pinnedRecent, N1]);
    expect(list.map((item) => item.id)).toEqual(['n2', 'p1', 'n3', 'n1']);
  });

  it('canLoadMore until the last page', () => {
    expect(canLoadMore(ready())).toBe(true);
    expect(canLoadMore({ ...ready(), page: 3 })).toBe(false);
  });
});
