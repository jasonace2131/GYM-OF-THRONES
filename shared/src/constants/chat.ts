/**
 * Coach <-> member chat (feat/coach-tools): the numbers and names both runtimes
 * must agree on.
 */

/** A message is 1-2000 characters of plain text (`ChatMessage_body_length`). */
export const CHAT_MESSAGE_MAX_LENGTH = 2000;

/** A sender may withdraw their own message for this long after sending it. */
export const CHAT_DELETE_WINDOW_MINUTES = 10;

/** The Realtime Broadcast event every chat push travels as. */
export const CHAT_BROADCAST_EVENT = 'chat.message';

/**
 * The private Realtime channel a signed-in person listens on.
 *
 * Keyed on the SUPABASE AUTH id (`session.user.id`, the JWT `sub`, stored as
 * `User.supabaseId`) — not on `User.id`. The one policy on `realtime.messages`
 * compares the topic with `auth.uid()`, and `auth.uid()` is the auth id; a
 * channel named after `User.id` would be refused to its own owner.
 */
export function chatUserTopic(authUserId: string): string {
  return `user:${authUserId}`;
}
