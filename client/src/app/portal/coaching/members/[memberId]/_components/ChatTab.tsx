'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { chatApi } from '@/lib/chat/chatApi';
import { useChat } from '@/components/chat/RealtimeProvider';
import { ChatHeader, ChatPanel } from '@/components/chat/ChatPanel';
import { Card, EmptyState, Skeleton } from '@/components/portal/ui';

type Open =
  | { kind: 'loading' }
  | { kind: 'ok'; threadId: string }
  | { kind: 'minor' }
  | { kind: 'not-assigned' }
  | { kind: 'failed' };

/**
 * The Chat tab: the one conversation between this coach and this client.
 *
 * `POST /chat/threads/with/:memberId` opens it — or gets it, if it exists —
 * under the `coachedMember` scope. A member under 18 is refused by the server
 * (CHAT_MINOR, owner decision) and this says so plainly rather than showing
 * an empty box.
 */
export function ChatTab({ memberId, firstName }: { memberId: string; firstName: string }) {
  const chat = useChat();
  const upsertThread = chat?.upsertThread;
  const [open, setOpen] = useState<Open>({ kind: 'loading' });

  useEffect(() => {
    if (upsertThread === undefined) return;
    let cancelled = false;
    chatApi.openWith(memberId).then(
      (thread) => {
        if (cancelled) return;
        upsertThread(thread);
        setOpen({ kind: 'ok', threadId: thread.id });
      },
      (caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.code === 'CHAT_MINOR') setOpen({ kind: 'minor' });
        else if (caught instanceof ApiError && caught.status === 404) {
          setOpen({ kind: 'not-assigned' });
        } else setOpen({ kind: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [memberId, upsertThread]);

  if (open.kind === 'loading') return <Skeleton height={360} />;

  if (open.kind === 'minor') {
    return (
      <Card>
        <EmptyState
          title="No 1:1 chat with members under 18"
          hint={`${firstName} is under 18, so coach chat is closed for them. Talk at the gym, or pass messages through the front desk.`}
        />
      </Card>
    );
  }

  if (open.kind === 'not-assigned') {
    return (
      <Card>
        <EmptyState
          title="You don't coach this member now"
          hint="Chat is open only while a member is assigned to you."
        />
      </Card>
    );
  }

  if (open.kind === 'failed') {
    return (
      <Card>
        <EmptyState
          title="Could not open the conversation"
          hint="This is usually the network. Reload the page to try again."
        />
      </Card>
    );
  }

  const thread = chat?.state.threads[open.threadId];
  return (
    <ChatPanel
      key={open.threadId}
      threadId={open.threadId}
      height="min(72vh, 680px)"
      title={
        thread === undefined ? (
          <strong>Chat with {firstName}</strong>
        ) : (
          <ChatHeader
            party={thread.member}
            subtitle={thread.writable ? 'Your client' : 'Coaching ended · read-only'}
          />
        )
      }
    />
  );
}
