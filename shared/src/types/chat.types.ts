/**
 * Coach <-> member chat on the wire (feat/coach-tools).
 *
 * Instants are ISO strings. A message body is PLAIN TEXT and is never
 * rendered as HTML by any client.
 */

/** One side of a thread, as a chat screen needs them. Nothing more. */
export interface ChatParty {
  id: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
}

export interface ChatMessageView {
  id: string;
  threadId: string;
  senderId: string;
  /** NULL once the sender has withdrawn it — a tombstone, not a gap. */
  body: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

/** Why a thread the caller can read is not one they can write to. */
export type ChatReadOnlyReason = 'ASSIGNMENT_ENDED';

export interface ChatThreadView {
  id: string;
  /** The caller's side of this thread. */
  role: 'COACH' | 'MEMBER';
  coach: ChatParty;
  member: ChatParty;
  /** True only while the pair has an ACTIVE coach assignment. */
  writable: boolean;
  readOnlyReason: ChatReadOnlyReason | null;
  lastMessage: ChatMessageView | null;
  lastMessageAt: string | null;
  /** Messages from the other party the caller has not read. */
  unread: number;
  createdAt: string;
}

/** `GET /chat/threads`. */
export interface ChatThreadList {
  threads: ChatThreadView[];
  /**
   * The caller is a member under 18 by date of birth, so chat is closed to
   * them (owner decision). Their screen says so rather than showing nothing.
   */
  minor: boolean;
}

/** `GET /chat/threads/:id/messages` — always oldest first. */
export interface ChatMessagePage {
  messages: ChatMessageView[];
  /** More exist beyond this page in the direction asked for. */
  hasMore: boolean;
}

/** What a `chat.message` broadcast carries. Untrusted until checked. */
export interface ChatBroadcastPayload {
  threadId: string;
  message: ChatMessageView;
  /** Echo of the sender's optimistic id, so their own tab can reconcile. */
  clientId: string | null;
}
