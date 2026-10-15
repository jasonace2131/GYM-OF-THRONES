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
import type { RealtimeChannel } from '@supabase/supabase-js';
import { CHAT_BROADCAST_EVENT, PERMISSIONS, chatUserTopic, type ChatThreadView } from '@got/shared';
import { supabase } from '@/lib/supabase';
import { ApiError } from '@/lib/api';
import { hasPermission } from '@/lib/rbac/permissions';
import { chatApi } from '@/lib/chat/chatApi';
import {
  INITIAL_CHAT,
  chatReducer,
  latestMessageId,
  oldestMessageId,
  totalUnread,
  type ChatState,
} from '@/lib/chat/chatState';
import { parseChatBroadcast, shouldCatchUp } from '@/lib/chat/realtime';
import { useMe } from '@/components/rbac/MeProvider';
import type { NavBadgeCounts } from '@/components/portal/nav';

/**
 * ONE REALTIME SOCKET PER SIGNED-IN BROWSER, AND THE CHAT STATE BEHIND IT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Mounted once in the portal layout. For a caller holding `chat.use` it:
 *
 *   1. hands Supabase Realtime the session's access token (`setAuth`), and
 *      again on every token refresh;
 *   2. joins ONE private channel, `user:<auth id>` — the only channel the
 *      `realtime.messages` policy lets them join — and listens for
 *      `chat.message`;
 *   3. CATCHES UP through the API on subscribe, on reconnect and on window
 *      focus, because Broadcast does not guarantee delivery. The API is the
 *      record; the socket is only the doorbell.
 *
 * Nobody without `chat.use` opens a socket at all. Everything about what is
 * on screen is the pure `chatReducer` (lib/chat/chatState.ts).
 *
 * Typing and presence are deliberately absent (v1): they would need
 * client-to-client channels and more policies.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type ChatConnection = 'off' | 'connecting' | 'live' | 'offline';

export interface ChatContextValue {
  state: ChatState;
  enabled: boolean;
  connection: ChatConnection;
  refreshThreads: () => Promise<void>;
  /** Show a thread: load or catch up its history, and mark it read. */
  openThread: (threadId: string) => void;
  closeThread: (threadId: string) => void;
  loadOlder: (threadId: string) => Promise<void>;
  /** Resolves null on success, or the message to show the sender. */
  send: (threadId: string, body: string) => Promise<string | null>;
  remove: (messageId: string) => Promise<string | null>;
  upsertThread: (thread: ChatThreadView) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

/** How many `after` pages one catch-up will follow before giving up. */
const CATCH_UP_PAGES = 5;

const newClientId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const reasonOf = (caught: unknown, fallback: string): string =>
  caught instanceof ApiError ? caught.message : fallback;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { me } = useMe();
  const meId = me?.id ?? null;
  const enabled = hasPermission(me?.permissions ?? null, PERMISSIONS.CHAT_USE);

  const [state, dispatch] = useReducer(chatReducer, INITIAL_CHAT);
  const [connection, setConnection] = useState<ChatConnection>('off');

  // The latest state for callbacks bound once (socket handlers, listeners).
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);

  // A different account, or none: forget everything the last one could see.
  useEffect(() => {
    dispatch({ type: 'reset', meId });
  }, [meId]);

  const refreshThreads = useCallback(async (): Promise<void> => {
    try {
      const list = await chatApi.threads();
      dispatch({ type: 'threadsLoaded', threads: list.threads, minor: list.minor });
    } catch {
      // The list keeps what it had; the next focus or reconnect tries again.
    }
  }, []);

  const markRead = useCallback(async (threadId: string): Promise<void> => {
    dispatch({ type: 'threadRead', threadId });
    try {
      await chatApi.markRead(threadId);
    } catch {
      // Unread is recounted by the server on the next thread list.
    }
  }, []);

  /** Newest page for a thread never loaded; everything after the cursor otherwise. */
  const catchUpThread = useCallback(async (threadId: string): Promise<void> => {
    const known = latest.current.hasOlder[threadId] !== undefined;
    try {
      if (!known) {
        const page = await chatApi.messages(threadId);
        dispatch({ type: 'pageLoaded', threadId, direction: 'latest', ...page });
        return;
      }
      // The next cursor comes from the page just read, not from state: a
      // dispatch is not visible in `latest` until React has rendered.
      let after = latestMessageId(latest.current, threadId);
      for (let i = 0; i < CATCH_UP_PAGES; i += 1) {
        const page = await chatApi.messages(threadId, after === null ? {} : { after });
        dispatch({
          type: 'pageLoaded',
          threadId,
          direction: after === null ? 'latest' : 'after',
          ...page,
        });
        const last = page.messages[page.messages.length - 1];
        if (after === null || !page.hasMore || last === undefined) return;
        after = last.id;
      }
    } catch {
      // Shown as-is; the next catch-up tries again.
    }
  }, []);

  const lastCatchUp = useRef<number | null>(null);
  const catchUp = useCallback(
    async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && !shouldCatchUp(lastCatchUp.current, now)) return;
      lastCatchUp.current = now;
      await refreshThreads();
      const open = latest.current.openThreadId;
      if (open !== null) {
        await catchUpThread(open);
        if (document.visibilityState === 'visible') void markRead(open);
      }
    },
    [refreshThreads, catchUpThread, markRead],
  );

  // ── The socket ────────────────────────────────────────────────────────
  useEffect(() => {
    // No socket for a caller without chat.use; `connection` reads 'off' for
    // them (see `value` below) without a state write here.
    if (!enabled || meId === null) return;

    let cancelled = false;
    let channel: RealtimeChannel | null = null;

    const onBroadcast = ({ payload }: { payload: unknown }): void => {
      const parsed = parseChatBroadcast(payload);
      if (parsed === null) return;
      const known = latest.current.threads[parsed.threadId] !== undefined;
      dispatch({
        type: 'messageReceived',
        threadId: parsed.threadId,
        message: parsed.message,
        clientId: parsed.clientId,
      });
      // A thread this screen has never heard of: a coach opened it just now.
      if (!known) void refreshThreads();
      if (
        latest.current.openThreadId === parsed.threadId &&
        parsed.message.senderId !== meId &&
        document.visibilityState === 'visible'
      ) {
        void markRead(parsed.threadId);
      }
    };

    const connect = async (): Promise<void> => {
      setConnection('connecting');
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (cancelled || session === null) return;

      await supabase.realtime.setAuth(session.access_token);
      if (cancelled) return;

      channel = supabase
        .channel(chatUserTopic(session.user.id), { config: { private: true } })
        .on('broadcast', { event: CHAT_BROADCAST_EVENT }, onBroadcast)
        .subscribe((status) => {
          if (cancelled) return;
          if (status === 'SUBSCRIBED') {
            setConnection('live');
            // Subscribe AND every re-subscribe after a drop: whatever the
            // socket missed while it was down comes from the API.
            void catchUp(true);
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            setConnection('offline');
          }
        });
    };

    void catchUp(true);
    void connect();

    // A refreshed token must reach the socket, or the channel is dropped
    // when the old one expires.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (session !== null && (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN')) {
        void supabase.realtime.setAuth(session.access_token);
      }
    });

    const onFocus = (): void => {
      if (document.visibilityState === 'visible') void catchUp();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      if (channel !== null) void supabase.removeChannel(channel);
    };
  }, [enabled, meId, catchUp, refreshThreads, markRead]);

  // ── Actions ───────────────────────────────────────────────────────────
  const openThread = useCallback(
    (threadId: string): void => {
      dispatch({ type: 'threadOpened', threadId });
      void catchUpThread(threadId).then(() => {
        if (document.visibilityState === 'visible') void markRead(threadId);
      });
    },
    [catchUpThread, markRead],
  );

  const closeThread = useCallback((threadId: string): void => {
    dispatch({ type: 'threadClosed', threadId });
  }, []);

  const loadOlder = useCallback(async (threadId: string): Promise<void> => {
    const before = oldestMessageId(latest.current, threadId);
    if (before === null) return;
    try {
      const page = await chatApi.messages(threadId, { before });
      dispatch({ type: 'pageLoaded', threadId, direction: 'before', ...page });
    } catch {
      // The button stays; tapping it again retries.
    }
  }, []);

  const send = useCallback(async (threadId: string, body: string): Promise<string | null> => {
    const clientId = newClientId();
    dispatch({
      type: 'sendStarted',
      pending: { clientId, threadId, body, createdAt: new Date().toISOString() },
    });
    try {
      const message = await chatApi.send(threadId, body, clientId);
      dispatch({ type: 'sendSucceeded', clientId, message });
      return null;
    } catch (caught) {
      // ROLLBACK: the pending bubble goes; the caller puts the text back.
      dispatch({ type: 'sendFailed', threadId, clientId });
      return reasonOf(caught, 'That message did not send. Check your connection and try again.');
    }
  }, []);

  const remove = useCallback(async (messageId: string): Promise<string | null> => {
    try {
      const tombstone = await chatApi.remove(messageId);
      dispatch({
        type: 'messageReceived',
        threadId: tombstone.threadId,
        message: tombstone,
        clientId: null,
      });
      return null;
    } catch (caught) {
      return reasonOf(caught, 'That message could not be removed.');
    }
  }, []);

  const upsertThread = useCallback((thread: ChatThreadView): void => {
    dispatch({ type: 'threadUpserted', thread });
  }, []);

  const value = useMemo<ChatContextValue>(
    () => ({
      state,
      enabled,
      connection: enabled && meId !== null ? connection : 'off',
      refreshThreads,
      openThread,
      closeThread,
      loadOlder,
      send,
      remove,
      upsertThread,
    }),
    [
      state,
      enabled,
      meId,
      connection,
      refreshThreads,
      openThread,
      closeThread,
      loadOlder,
      send,
      remove,
      upsertThread,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

/** The chat on this surface, or null outside a `RealtimeProvider`. */
export function useChat(): ChatContextValue | null {
  return useContext(ChatContext);
}

/**
 * The nav's unread counts. Empty outside a provider (the console) and for a
 * caller without `chat.use`, so no badge is ever backed by nothing.
 */
export function useNavBadges(): NavBadgeCounts {
  const chat = useContext(ChatContext);
  return useMemo<NavBadgeCounts>(() => {
    if (chat === null || !chat.enabled) return {};
    return {
      chatAsCoach: totalUnread(chat.state, 'COACH'),
      chatAsMember: totalUnread(chat.state, 'MEMBER'),
    };
  }, [chat]);
}
