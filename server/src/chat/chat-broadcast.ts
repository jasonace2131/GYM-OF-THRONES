import { CHAT_BROADCAST_EVENT, chatUserTopic, type ChatBroadcastPayload } from '@got/shared';

/** One entry of Supabase Realtime's REST broadcast body. */
export interface BroadcastMessage {
  topic: string;
  event: string;
  payload: ChatBroadcastPayload;
  private: true;
}

/**
 * The `messages` array for `POST /realtime/v1/api/broadcast`: one PRIVATE
 * `chat.message` per participant, on their own `user:<authId>` channel.
 *
 * The SENDER is a recipient too, on purpose — their other tabs and devices
 * learn of the message the same way the other party does.
 *
 * `recipients` are Supabase AUTH ids (`User.supabaseId`), because that is what
 * `auth.uid()` returns in the channel policy; see `chatUserTopic`.
 */
export function chatBroadcastMessages(
  recipients: readonly string[],
  payload: ChatBroadcastPayload,
): BroadcastMessage[] {
  return [...new Set(recipients)].map((authId) => ({
    topic: chatUserTopic(authId),
    event: CHAT_BROADCAST_EVENT,
    payload,
    private: true,
  }));
}
