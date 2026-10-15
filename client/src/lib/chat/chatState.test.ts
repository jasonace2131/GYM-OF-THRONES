import { describe, expect, it } from 'vitest';
import type { ChatMessageView, ChatThreadView } from '@got/shared';
import {
  INITIAL_CHAT,
  canDeleteMessage,
  chatReducer,
  latestMessageId,
  oldestMessageId,
  sortedThreads,
  threadTimeline,
  totalUnread,
  type ChatState,
} from './chatState';

const ME = 'me-coach';
const THEM = 'them-member';

const msg = (
  id: string,
  at: string,
  overrides: Partial<ChatMessageView> = {},
): ChatMessageView => ({
  id,
  threadId: 't1',
  senderId: THEM,
  body: `body ${id}`,
  createdAt: `2026-09-25T02:${at}.000Z`,
  editedAt: null,
  deletedAt: null,
  ...overrides,
});

const thread = (id: string, overrides: Partial<ChatThreadView> = {}): ChatThreadView => ({
  id,
  role: 'COACH',
  coach: { id: ME, firstName: 'Ana', lastName: 'Reyes', avatarUrl: null },
  member: { id: THEM, firstName: 'Ben', lastName: 'Cruz', avatarUrl: null },
  writable: true,
  readOnlyReason: null,
  lastMessage: null,
  lastMessageAt: null,
  unread: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

const start = (threads: ChatThreadView[] = [thread('t1')]): ChatState =>
  chatReducer(chatReducer(INITIAL_CHAT, { type: 'reset', meId: ME }), {
    type: 'threadsLoaded',
    threads,
    minor: false,
  });

const ids = (state: ChatState, threadId = 't1'): string[] =>
  (state.messages[threadId] ?? []).map((m) => m.id);

describe('chatReducer — merging', () => {
  it('merges pages in any order into one list, oldest first, without duplicates', () => {
    let state = start();
    state = chatReducer(state, {
      type: 'pageLoaded',
      threadId: 't1',
      direction: 'latest',
      messages: [msg('c', '03:00'), msg('d', '04:00')],
      hasMore: true,
    });
    state = chatReducer(state, {
      type: 'pageLoaded',
      threadId: 't1',
      direction: 'before',
      messages: [msg('a', '01:00'), msg('b', '02:00'), msg('c', '03:00')],
      hasMore: false,
    });
    state = chatReducer(state, {
      type: 'pageLoaded',
      threadId: 't1',
      direction: 'after',
      messages: [msg('d', '04:00'), msg('e', '05:00')],
      hasMore: false,
    });

    expect(ids(state)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(state.hasOlder['t1']).toBe(false);
  });

  it('orders two messages from the same millisecond by id, like the server', () => {
    const state = chatReducer(start(), {
      type: 'pageLoaded',
      threadId: 't1',
      direction: 'latest',
      messages: [msg('y', '01:00'), msg('x', '01:00')],
      hasMore: false,
    });
    expect(ids(state)).toEqual(['x', 'y']);
  });

  it('never un-deletes: a stale copy does not overwrite a tombstone', () => {
    let state = start();
    state = chatReducer(state, {
      type: 'messageReceived',
      threadId: 't1',
      message: msg('a', '01:00', { body: null, deletedAt: '2026-09-25T02:02:00.000Z' }),
      clientId: null,
    });
    state = chatReducer(state, {
      type: 'pageLoaded',
      threadId: 't1',
      direction: 'latest',
      messages: [msg('a', '01:00')],
      hasMore: false,
    });
    expect(state.messages['t1']?.[0]).toMatchObject({ id: 'a', body: null });
  });
});

describe('chatReducer — live messages and unread', () => {
  it("counts the other party's new message as unread, once", () => {
    let state = start();
    const incoming = {
      type: 'messageReceived',
      threadId: 't1',
      message: msg('a', '01:00'),
      clientId: null,
    } as const;
    state = chatReducer(state, incoming);
    state = chatReducer(state, incoming); // the catch-up read brings it again

    expect(state.threads['t1']?.unread).toBe(1);
    expect(state.threads['t1']?.lastMessage?.id).toBe('a');
    expect(state.threads['t1']?.lastMessageAt).toBe('2026-09-25T02:01:00.000Z');
  });

  it('does not count my own message, a tombstone, or a message in the thread on screen', () => {
    let state = start();
    state = chatReducer(state, {
      type: 'messageReceived',
      threadId: 't1',
      message: msg('mine', '01:00', { senderId: ME }),
      clientId: null,
    });
    state = chatReducer(state, {
      type: 'messageReceived',
      threadId: 't1',
      message: msg('gone', '02:00', { body: null, deletedAt: '2026-09-25T02:03:00.000Z' }),
      clientId: null,
    });
    state = chatReducer(state, { type: 'threadOpened', threadId: 't1' });
    state = chatReducer(state, {
      type: 'messageReceived',
      threadId: 't1',
      message: msg('seen', '03:00'),
      clientId: null,
    });
    expect(state.threads['t1']?.unread).toBe(0);
  });

  it('keeps the newest message as the thread preview whatever order they arrive in', () => {
    let state = start();
    state = chatReducer(state, {
      type: 'messageReceived',
      threadId: 't1',
      message: msg('late', '05:00'),
      clientId: null,
    });
    state = chatReducer(state, {
      type: 'messageReceived',
      threadId: 't1',
      message: msg('early', '01:00'),
      clientId: null,
    });
    expect(state.threads['t1']?.lastMessage?.id).toBe('late');
  });

  it('opening a thread clears its unread; reading does too', () => {
    let state = start([thread('t1', { unread: 4 }), thread('t2', { unread: 2 })]);
    state = chatReducer(state, { type: 'threadOpened', threadId: 't1' });
    state = chatReducer(state, { type: 'threadRead', threadId: 't2' });
    expect(totalUnread(state)).toBe(0);
  });

  it('a fresh thread list keeps the thread on screen at zero unread', () => {
    let state = chatReducer(start(), { type: 'threadOpened', threadId: 't1' });
    state = chatReducer(state, {
      type: 'threadsLoaded',
      threads: [thread('t1', { unread: 1 })],
      minor: false,
    });
    expect(state.threads['t1']?.unread).toBe(0);
  });
});

describe('chatReducer — optimistic send', () => {
  const pending = {
    clientId: 'tmp-1',
    threadId: 't1',
    body: 'On my way',
    createdAt: '2026-09-25T02:09:00.000Z',
  };

  it('shows a pending bubble at once, then swaps it for the saved message', () => {
    let state = chatReducer(start(), { type: 'sendStarted', pending });
    expect(threadTimeline(state, 't1').map((item) => item.kind)).toEqual(['pending']);

    state = chatReducer(state, {
      type: 'sendSucceeded',
      clientId: 'tmp-1',
      message: msg('saved', '09:00', { senderId: ME, body: 'On my way' }),
    });

    expect(threadTimeline(state, 't1')).toEqual([
      {
        kind: 'message',
        message: msg('saved', '09:00', { senderId: ME, body: 'On my way' }),
        mine: true,
      },
    ]);
    expect(state.threads['t1']?.unread).toBe(0);
  });

  it('the broadcast of my own message can land first — it reconciles by client id', () => {
    let state = chatReducer(start(), { type: 'sendStarted', pending });
    state = chatReducer(state, {
      type: 'messageReceived',
      threadId: 't1',
      message: msg('saved', '09:00', { senderId: ME }),
      clientId: 'tmp-1',
    });
    expect(state.pending['t1']).toEqual([]);
    // …and the POST's own answer then changes nothing.
    state = chatReducer(state, {
      type: 'sendSucceeded',
      clientId: 'tmp-1',
      message: msg('saved', '09:00', { senderId: ME }),
    });
    expect(ids(state)).toEqual(['saved']);
  });

  it('rolls back a failed send — the bubble goes, nothing is left behind', () => {
    let state = chatReducer(start(), { type: 'sendStarted', pending });
    state = chatReducer(state, { type: 'sendFailed', threadId: 't1', clientId: 'tmp-1' });
    expect(threadTimeline(state, 't1')).toEqual([]);
    expect(ids(state)).toEqual([]);
  });
});

describe('selectors', () => {
  it('sorts threads by latest activity, silent ones last', () => {
    const state = start([
      thread('quiet'),
      thread('old', { lastMessageAt: '2026-09-20T00:00:00.000Z' }),
      thread('new', { lastMessageAt: '2026-09-24T00:00:00.000Z' }),
    ]);
    expect(sortedThreads(state).map((t) => t.id)).toEqual(['new', 'old', 'quiet']);
  });

  it('totals unread per role, so a coach badge ignores their own member thread', () => {
    const state = start([
      thread('as-coach', { unread: 2 }),
      thread('as-member', { unread: 5, role: 'MEMBER' }),
    ]);
    expect(totalUnread(state)).toBe(7);
    expect(totalUnread(state, 'COACH')).toBe(2);
    expect(totalUnread(state, 'MEMBER')).toBe(5);
  });

  it('gives the catch-up cursor and the load-earlier cursor', () => {
    const state = chatReducer(start(), {
      type: 'pageLoaded',
      threadId: 't1',
      direction: 'latest',
      messages: [msg('a', '01:00'), msg('b', '02:00')],
      hasMore: true,
    });
    expect(latestMessageId(state, 't1')).toBe('b');
    expect(oldestMessageId(state, 't1')).toBe('a');
    expect(latestMessageId(state, 'unknown')).toBeNull();
  });

  it('lets the sender withdraw their own live message for ten minutes only', () => {
    const now = new Date('2026-09-25T02:11:00.000Z');
    expect(canDeleteMessage(msg('a', '01:30', { senderId: ME }), ME, now)).toBe(true);
    expect(canDeleteMessage(msg('a', '00:59', { senderId: ME }), ME, now)).toBe(false);
    expect(canDeleteMessage(msg('a', '05:00'), ME, now)).toBe(false);
    expect(
      canDeleteMessage(
        msg('a', '05:00', { senderId: ME, deletedAt: '2026-09-25T02:06:00.000Z' }),
        ME,
        now,
      ),
    ).toBe(false);
  });

  it('reset forgets everything — a second account on the same phone inherits nothing', () => {
    const state = chatReducer(start([thread('t1', { unread: 3 })]), {
      type: 'reset',
      meId: 'other',
    });
    expect(state).toEqual({ ...INITIAL_CHAT, meId: 'other' });
  });
});
