import type { ChatMessageView, ChatParty } from '@got/shared';

/**
 * What a chat read selects about each participant.
 *
 * `supabaseId` is the Realtime channel address and never leaves the server;
 * `dateOfBirth` feeds the minors rule and never leaves it either; `deletedAt`
 * hides a thread whose other party is gone. `toParty` projects the rest.
 */
export const CHAT_PARTY_SELECT = {
  id: true,
  supabaseId: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  dateOfBirth: true,
  deletedAt: true,
} as const;

export interface PartyRow {
  id: string;
  supabaseId: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  dateOfBirth: Date | null;
  deletedAt: Date | null;
}

export const CHAT_THREAD_INCLUDE = {
  coach: { select: CHAT_PARTY_SELECT },
  member: { select: CHAT_PARTY_SELECT },
} as const;

export interface ThreadRow {
  id: string;
  coachId: string;
  memberId: string;
  createdAt: Date;
  lastMessageAt: Date | null;
  coach: PartyRow;
  member: PartyRow;
}

export interface MessageRow {
  id: string;
  threadId: string;
  senderId: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

/** Names and a photo — never a phone, an email, a date of birth or an auth id. */
export function toParty(row: PartyRow): ChatParty {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    avatarUrl: row.avatarUrl,
  };
}

/**
 * A withdrawn message is a TOMBSTONE for its participants: the row stays (a
 * complaint review may need it) but its body is not sent.
 */
export function toMessageView(row: MessageRow): ChatMessageView {
  return {
    id: row.id,
    threadId: row.threadId,
    senderId: row.senderId,
    body: row.deletedAt === null ? row.body : null,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/** The review screen's message: the body ALWAYS, with the withdrawal flagged. */
export interface ReviewMessageView {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
  deletedAt: string | null;
}

export function toReviewMessage(row: MessageRow): ReviewMessageView {
  return {
    id: row.id,
    senderId: row.senderId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export function fullName(party: { firstName: string; lastName: string }): string {
  return `${party.firstName} ${party.lastName}`.trim();
}
