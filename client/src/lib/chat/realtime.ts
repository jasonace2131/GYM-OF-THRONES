import type { ChatBroadcastPayload, ChatMessageView } from '@got/shared';

/**
 * The browser end of the chat's live push (feat/coach-tools).
 *
 * A broadcast arrives over the Supabase Realtime socket, so it is UNTRUSTED
 * input until checked: `parseChatBroadcast` accepts exactly the shape the API
 * sends and nothing else. It is only a doorbell anyway — the API is the
 * record, and the catch-up read (`shouldCatchUp`) is what makes a missed
 * broadcast harmless.
 */

const isString = (value: unknown): value is string => typeof value === 'string';
const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

function isMessage(value: unknown): value is ChatMessageView {
  if (value === null || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    isString(m['id']) &&
    isString(m['threadId']) &&
    isString(m['senderId']) &&
    isStringOrNull(m['body']) &&
    isString(m['createdAt']) &&
    isStringOrNull(m['editedAt']) &&
    isStringOrNull(m['deletedAt'])
  );
}

export function parseChatBroadcast(payload: unknown): ChatBroadcastPayload | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const message = p['message'];
  if (!isString(p['threadId']) || !isMessage(message)) return null;
  if (message.threadId !== p['threadId']) return null;
  const clientId = p['clientId'];
  return {
    threadId: p['threadId'],
    message: {
      id: message.id,
      threadId: message.threadId,
      senderId: message.senderId,
      body: message.body,
      createdAt: message.createdAt,
      editedAt: message.editedAt,
      deletedAt: message.deletedAt,
    },
    clientId: isString(clientId) ? clientId : null,
  };
}

/**
 * Focus, visibility and a socket reconnect tend to fire together. One catch-up
 * covers them all; the next is allowed after this long.
 */
export const CATCH_UP_MIN_INTERVAL_MS = 5_000;

export function shouldCatchUp(lastAt: number | null, now: number): boolean {
  return lastAt === null || now - lastAt >= CATCH_UP_MIN_INTERVAL_MS;
}
