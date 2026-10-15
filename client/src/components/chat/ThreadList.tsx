'use client';

import type { ChatThreadView } from '@got/shared';
import { GYM_TIMEZONE } from '@/lib/gymTime';
import { messagesBadge } from '@/lib/chat/badge';
import { messageTime, otherParty, threadPreview } from '@/lib/chat/format';
import { PartyAvatar } from './ChatPanel';

/**
 * The inbox: one row per conversation, newest activity first, with the other
 * person's photo, name, a one-line preview, when it was sent and an unread
 * count. An unread conversation's name and preview go bold, the way every
 * messenger marks one.
 *
 * Portal classes only — this folder is not a Tailwind `@source`, and the
 * containment check keeps it that way.
 */
export function ThreadList({
  threads,
  selectedId,
  meId,
  onSelect,
}: {
  threads: ChatThreadView[];
  selectedId: string | null;
  meId: string | null;
  onSelect: (threadId: string) => void;
}) {
  const now = new Date();
  return (
    <div className="p-thread-list" role="list" aria-label="Conversations">
      {threads.map((thread) => {
        const person = otherParty(thread);
        const badge = messagesBadge(thread.unread);
        return (
          <button
            key={thread.id}
            type="button"
            role="listitem"
            className="p-thread"
            data-unread={thread.unread > 0}
            aria-current={thread.id === selectedId ? 'true' : undefined}
            aria-label={`${person.firstName} ${person.lastName}, ${badge.spoken}`}
            onClick={() => onSelect(thread.id)}
          >
            <PartyAvatar party={person} className="p-avatar-md" size={44} />
            <span style={{ minWidth: 0, flex: 1, display: 'grid', gap: 2 }}>
              <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
                <span className="p-thread-name">
                  {person.firstName} {person.lastName}
                </span>
                {thread.lastMessageAt !== null ? (
                  <span className="p-thread-time">
                    {messageTime(thread.lastMessageAt, now, GYM_TIMEZONE)}
                  </span>
                ) : null}
              </span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                <span className="p-thread-preview" style={{ flex: 1 }}>
                  {!thread.writable ? 'Ended · ' : ''}
                  {threadPreview(thread.lastMessage, meId)}
                </span>
                {badge.text !== null ? (
                  <span className="p-nav-badge" style={{ marginLeft: 0 }} aria-hidden>
                    {badge.text}
                  </span>
                ) : null}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
