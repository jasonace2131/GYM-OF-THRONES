import { CHAT_DELETE_WINDOW_MINUTES, type ChatMessageView, type ChatThreadView } from '@got/shared';

/**
 * THE CHAT ON SCREEN, AS A PURE REDUCER (feat/coach-tools).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Messages reach a browser three ways, in any order and more than once:
 *
 *   - pages from the API (the first open, "load earlier", and the CATCH-UP
 *     read `?after=` on subscribe, reconnect and focus);
 *   - the Supabase Realtime broadcast, which is fast and not guaranteed;
 *   - the answer to the browser's own POST.
 *
 * So everything here MERGES: deduped by id, ordered by (createdAt, id) the way
 * the server pages them, a withdrawn message never coming back to life, and
 * an unread counted once however many times the same message arrives.
 *
 * A send is OPTIMISTIC: a pending bubble shows at once and is swapped for the
 * saved message by its client id — whichever of the POST's answer or the
 * broadcast lands first — and a failed send is ROLLED BACK (the bubble goes;
 * the composer gets the text back).
 *
 * Bodies are plain text. Nothing here, or anywhere that renders it, treats a
 * body as HTML.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface PendingMessage {
  clientId: string;
  threadId: string;
  body: string;
  createdAt: string;
}

export interface ChatState {
  /** The signed-in user's `User.id` — what `senderId` is compared with. */
  meId: string | null;
  threads: Record<string, ChatThreadView>;
  /** Confirmed messages per thread, oldest first, unique by id. */
  messages: Record<string, ChatMessageView[]>;
  /** Sends not yet confirmed, per thread. */
  pending: Record<string, PendingMessage[]>;
  /**
   * Whether older history exists. ABSENT means the thread's history has never
   * been loaded — which is how a screen knows to load the newest page.
   */
  hasOlder: Record<string, boolean>;
  /** The thread on screen: its incoming messages are read, not unread. */
  openThreadId: string | null;
  /** The caller is a member under 18 — chat is closed to them. */
  minor: boolean;
  /** The thread list has answered at least once. */
  loaded: boolean;
}

export const INITIAL_CHAT: ChatState = {
  meId: null,
  threads: {},
  messages: {},
  pending: {},
  hasOlder: {},
  openThreadId: null,
  minor: false,
  loaded: false,
};

export type PageDirection = 'latest' | 'before' | 'after';

export type ChatAction =
  | { type: 'reset'; meId: string | null }
  | { type: 'threadsLoaded'; threads: ChatThreadView[]; minor: boolean }
  | { type: 'threadUpserted'; thread: ChatThreadView }
  | {
      type: 'pageLoaded';
      threadId: string;
      direction: PageDirection;
      messages: ChatMessageView[];
      hasMore: boolean;
    }
  | {
      type: 'messageReceived';
      threadId: string;
      message: ChatMessageView;
      clientId: string | null;
    }
  | { type: 'sendStarted'; pending: PendingMessage }
  | { type: 'sendSucceeded'; clientId: string; message: ChatMessageView }
  | { type: 'sendFailed'; threadId: string; clientId: string }
  | { type: 'threadOpened'; threadId: string }
  | { type: 'threadClosed'; threadId: string }
  | { type: 'threadRead'; threadId: string };

/** The server's order: createdAt, then id. */
function compare(a: ChatMessageView, b: ChatMessageView): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Of two copies of one message, the one to keep: a tombstone always wins. */
function newerCopy(existing: ChatMessageView, incoming: ChatMessageView): ChatMessageView {
  if (existing.deletedAt !== null && incoming.deletedAt === null) return existing;
  return incoming;
}

function mergeMessages(
  current: readonly ChatMessageView[] | undefined,
  incoming: readonly ChatMessageView[],
): ChatMessageView[] {
  const byId = new Map((current ?? []).map((m) => [m.id, m]));
  for (const message of incoming) {
    const existing = byId.get(message.id);
    byId.set(message.id, existing === undefined ? message : newerCopy(existing, message));
  }
  return [...byId.values()].sort(compare);
}

/** Put a message into the thread's summary: preview, sort key, unread. */
function summarise(
  state: ChatState,
  threadId: string,
  message: ChatMessageView,
  countUnread: boolean,
): Record<string, ChatThreadView> {
  const thread = state.threads[threadId];
  if (thread === undefined) return state.threads;

  const last = thread.lastMessage;
  const lastMessage =
    last === null || compare(last, message) < 0
      ? message
      : last.id === message.id
        ? newerCopy(last, message)
        : last;
  const lastMessageAt =
    thread.lastMessageAt === null || thread.lastMessageAt < message.createdAt
      ? message.createdAt
      : thread.lastMessageAt;

  return {
    ...state.threads,
    [threadId]: {
      ...thread,
      lastMessage,
      lastMessageAt,
      unread: countUnread ? thread.unread + 1 : thread.unread,
    },
  };
}

function withoutPending(
  pending: Record<string, PendingMessage[]>,
  clientId: string,
): Record<string, PendingMessage[]> {
  const next: Record<string, PendingMessage[]> = {};
  for (const [threadId, list] of Object.entries(pending)) {
    next[threadId] = list.filter((p) => p.clientId !== clientId);
  }
  return next;
}

function receive(
  state: ChatState,
  threadId: string,
  message: ChatMessageView,
  clientId: string | null,
): ChatState {
  const known = (state.messages[threadId] ?? []).some((m) => m.id === message.id);
  const countUnread =
    !known &&
    message.senderId !== state.meId &&
    message.deletedAt === null &&
    state.openThreadId !== threadId;

  return {
    ...state,
    messages: { ...state.messages, [threadId]: mergeMessages(state.messages[threadId], [message]) },
    pending: clientId === null ? state.pending : withoutPending(state.pending, clientId),
    threads: summarise(state, threadId, message, countUnread),
  };
}

function setUnread(state: ChatState, threadId: string, unread: number): ChatState {
  const thread = state.threads[threadId];
  if (thread === undefined || thread.unread === unread) return state;
  return { ...state, threads: { ...state.threads, [threadId]: { ...thread, unread } } };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return { ...INITIAL_CHAT, meId: action.meId };

    case 'threadsLoaded': {
      // The server's list is the truth for summaries — except that the thread
      // on screen is being read as it arrives.
      const threads: Record<string, ChatThreadView> = {};
      for (const thread of action.threads) {
        threads[thread.id] = thread.id === state.openThreadId ? { ...thread, unread: 0 } : thread;
      }
      return { ...state, threads, minor: action.minor, loaded: true };
    }

    case 'threadUpserted': {
      const thread =
        action.thread.id === state.openThreadId ? { ...action.thread, unread: 0 } : action.thread;
      return { ...state, threads: { ...state.threads, [thread.id]: thread } };
    }

    case 'pageLoaded': {
      const hasOlder =
        action.direction === 'after'
          ? state.hasOlder
          : { ...state.hasOlder, [action.threadId]: action.hasMore };
      // A catch-up read of a thread never opened before still marks it loaded,
      // with its older history unknown and so assumed to exist.
      const withLoaded =
        hasOlder[action.threadId] === undefined
          ? { ...hasOlder, [action.threadId]: true }
          : hasOlder;
      const merged = mergeMessages(state.messages[action.threadId], action.messages);
      const newest = merged[merged.length - 1];
      return {
        ...state,
        hasOlder: withLoaded,
        messages: { ...state.messages, [action.threadId]: merged },
        threads:
          newest === undefined ? state.threads : summarise(state, action.threadId, newest, false),
      };
    }

    case 'messageReceived':
      return receive(state, action.threadId, action.message, action.clientId);

    case 'sendStarted': {
      const list = state.pending[action.pending.threadId] ?? [];
      return {
        ...state,
        pending: { ...state.pending, [action.pending.threadId]: [...list, action.pending] },
      };
    }

    case 'sendSucceeded':
      return receive(state, action.message.threadId, action.message, action.clientId);

    case 'sendFailed': {
      const list = state.pending[action.threadId] ?? [];
      return {
        ...state,
        pending: {
          ...state.pending,
          [action.threadId]: list.filter((p) => p.clientId !== action.clientId),
        },
      };
    }

    case 'threadOpened':
      return setUnread({ ...state, openThreadId: action.threadId }, action.threadId, 0);

    case 'threadClosed':
      return state.openThreadId === action.threadId ? { ...state, openThreadId: null } : state;

    case 'threadRead':
      return setUnread(state, action.threadId, 0);
  }
}

// ── Selectors ────────────────────────────────────────────────────────────

export type TimelineItem =
  | { kind: 'message'; message: ChatMessageView; mine: boolean }
  | { kind: 'pending'; pending: PendingMessage };

/** Saved messages oldest first, then this browser's sends still in flight. */
export function threadTimeline(state: ChatState, threadId: string): TimelineItem[] {
  const saved: TimelineItem[] = (state.messages[threadId] ?? []).map((message) => ({
    kind: 'message',
    message,
    mine: message.senderId === state.meId,
  }));
  const inFlight: TimelineItem[] = (state.pending[threadId] ?? []).map((pending) => ({
    kind: 'pending',
    pending,
  }));
  return [...saved, ...inFlight];
}

/** Most recent activity first; threads nobody has written in last. */
export function sortedThreads(state: ChatState, role?: ChatThreadView['role']): ChatThreadView[] {
  return Object.values(state.threads)
    .filter((thread) => role === undefined || thread.role === role)
    .sort((a, b) => {
      if (a.lastMessageAt !== b.lastMessageAt) {
        if (a.lastMessageAt === null) return 1;
        if (b.lastMessageAt === null) return -1;
        return a.lastMessageAt < b.lastMessageAt ? 1 : -1;
      }
      return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    });
}

/** Unread across threads — optionally only where the caller is the coach, or the member. */
export function totalUnread(state: ChatState, role?: ChatThreadView['role']): number {
  return Object.values(state.threads)
    .filter((thread) => role === undefined || thread.role === role)
    .reduce((sum, thread) => sum + thread.unread, 0);
}

/** The catch-up cursor: the newest SAVED message this browser holds. */
export function latestMessageId(state: ChatState, threadId: string): string | null {
  const list = state.messages[threadId];
  return list === undefined || list.length === 0 ? null : list[list.length - 1].id;
}

/** The "load earlier" cursor. */
export function oldestMessageId(state: ChatState, threadId: string): string | null {
  const list = state.messages[threadId];
  return list === undefined || list.length === 0 ? null : list[0].id;
}

const DELETE_WINDOW_MS = CHAT_DELETE_WINDOW_MINUTES * 60_000;

/** The same rule the server applies: my own, still live, under ten minutes old. */
export function canDeleteMessage(
  message: ChatMessageView,
  meId: string | null,
  now: Date,
): boolean {
  return (
    meId !== null &&
    message.senderId === meId &&
    message.deletedAt === null &&
    now.getTime() - new Date(message.createdAt).getTime() <= DELETE_WINDOW_MS
  );
}
