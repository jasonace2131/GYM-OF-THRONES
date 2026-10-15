import type { ChatMessagePage, ChatMessageView, ChatThreadList, ChatThreadView } from '@got/shared';
import { apiFetch } from '../api';

/**
 * The chat routes (`chat.use`). Thin on purpose: every rule about who may do
 * what is the server's (`chat-access.ts`), and every rule about what is on
 * screen is `chatState.ts`.
 *
 * Ids are ENCODED into paths: they come from state that came from the wire,
 * and a wrapper should not build a path it would not want to be called.
 */
const enc = encodeURIComponent;

export const chatApi = {
  threads: (): Promise<ChatThreadList> => apiFetch<ChatThreadList>('/chat/threads'),

  /** `after` is the catch-up read; `before` is "load earlier"; neither is the newest page. */
  messages: (
    threadId: string,
    cursor: { before?: string; after?: string; limit?: number } = {},
  ): Promise<ChatMessagePage> => {
    const search = new URLSearchParams();
    if (cursor.before !== undefined) search.set('before', cursor.before);
    if (cursor.after !== undefined) search.set('after', cursor.after);
    if (cursor.limit !== undefined) search.set('limit', String(cursor.limit));
    const query = search.toString();
    return apiFetch<ChatMessagePage>(
      `/chat/threads/${enc(threadId)}/messages${query === '' ? '' : `?${query}`}`,
    );
  },

  send: (threadId: string, body: string, clientId: string): Promise<ChatMessageView> =>
    apiFetch<ChatMessageView>(`/chat/threads/${enc(threadId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body, clientId }),
    }),

  markRead: (threadId: string): Promise<{ threadId: string; lastReadAt: string }> =>
    apiFetch(`/chat/threads/${enc(threadId)}/read`, { method: 'POST' }),

  /** 200 with the tombstone. Only the sender, only within ten minutes. */
  remove: (messageId: string): Promise<ChatMessageView> =>
    apiFetch<ChatMessageView>(`/chat/messages/${enc(messageId)}`, { method: 'DELETE' }),

  /** A coach opens — or gets — the thread with a member they coach. */
  openWith: (memberId: string): Promise<ChatThreadView> =>
    apiFetch<ChatThreadView>(`/chat/threads/with/${enc(memberId)}`, { method: 'POST' }),
};
