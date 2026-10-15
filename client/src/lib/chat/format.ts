import type { ChatMessageView, ChatParty, ChatThreadView } from '@got/shared';
import { formatGymTime, gymToday } from '../gymTime';

/**
 * What a chat screen prints about a message or a thread — text only, and in
 * the GYM's clock, the same rule every other time on the portal follows.
 */

const PREVIEW_MAX = 80;

/** "9:05 AM" today; "Sep 24, 9:05 AM" on any other gym day. */
export function messageTime(iso: string, now: Date, timeZone: string): string {
  const at = new Date(iso);
  const time = formatGymTime(at, timeZone);
  if (gymToday(at, timeZone) === gymToday(now, timeZone)) return time;
  const day = new Intl.DateTimeFormat('en-PH', {
    timeZone,
    day: 'numeric',
    month: 'short',
  }).format(at);
  return `${day}, ${time}`;
}

/** One line for the inbox: flattened, cut, and "You:" on my own. */
export function threadPreview(message: ChatMessageView | null, meId: string | null): string {
  if (message === null) return 'No messages yet';
  if (message.body === null) return 'Message removed';
  const flat = message.body.replace(/\s+/g, ' ').trim();
  const text = message.senderId === meId ? `You: ${flat}` : flat;
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX).trimEnd()}…` : text;
}

/** The person on the other side of the thread from the caller. */
export function otherParty(thread: Pick<ChatThreadView, 'role' | 'coach' | 'member'>): ChatParty {
  return thread.role === 'COACH' ? thread.member : thread.coach;
}

export function initialsOf(party: Pick<ChatParty, 'firstName' | 'lastName'>): string {
  return `${party.firstName[0] ?? ''}${party.lastName[0] ?? ''}`.toUpperCase();
}
