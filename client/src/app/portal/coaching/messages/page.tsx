'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PERMISSIONS } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import { useChat } from '@/components/chat/RealtimeProvider';
import { ChatHeader, ChatPanel } from '@/components/chat/ChatPanel';
import { ThreadList } from '@/components/chat/ThreadList';
import { sortedThreads } from '@/lib/chat/chatState';
import { otherParty } from '@/lib/chat/format';
import { Card, EmptyState, Skeleton } from '@/components/portal/ui';

/**
 * MESSAGES — the coach's inbox (feat/coach-tools), laid out like a desktop
 * messenger (owner, 2026-10-06): the conversation list on the left, the open
 * conversation filling the rest, both as tall as the window so the composer
 * is always on screen. On a phone the two take turns.
 *
 * Every conversation where the caller is the COACH: one per client they coach
 * now (opened automatically when the assignment exists) and read-only history
 * for clients they no longer coach. Newest activity first, unread counted.
 *
 * The selected thread lives in the URL hash (`#<threadId>`), read in an
 * effect — so a link can open a conversation directly, and this client page
 * needs no Suspense boundary for search params.
 */
export default function MessagesPage() {
  return (
    <RequirePermission permission={PERMISSIONS.COACH_READ}>
      <RequirePermission permission={PERMISSIONS.CHAT_USE}>
        <Inbox />
      </RequirePermission>
    </RequirePermission>
  );
}

function readHash(): string | null {
  if (typeof window === 'undefined') return null;
  const value = decodeURIComponent(window.location.hash.slice(1));
  return value === '' ? null : value;
}

function Inbox() {
  const chat = useChat();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const sync = (): void => setSelected(readHash());
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const select = useCallback((threadId: string | null): void => {
    setSelected(threadId);
    const url = `${window.location.pathname}${threadId === null ? '' : `#${encodeURIComponent(threadId)}`}`;
    window.history.replaceState(null, '', url);
  }, []);

  if (chat === null || !chat.state.loaded) {
    return (
      <div style={{ display: 'grid', gap: 14 }} aria-busy="true" aria-label="Loading messages">
        <Skeleton height={520} />
      </div>
    );
  }

  const threads = sortedThreads(chat.state, 'COACH');
  const current = selected === null ? undefined : chat.state.threads[selected];

  if (threads.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No conversations yet"
          hint="A conversation opens for every client assigned to you. Clients under 18 have no 1:1 chat."
          action={
            <Link href="/portal/coaching/clients" className="p-btn p-btn-ghost p-btn-sm">
              My clients
            </Link>
          }
        />
      </Card>
    );
  }

  const needle = query.trim().toLowerCase();
  const shown =
    needle === ''
      ? threads
      : threads.filter((thread) => {
          const person = otherParty(thread);
          return `${person.firstName} ${person.lastName}`.toLowerCase().includes(needle);
        });
  const unread = threads.reduce((sum, thread) => sum + thread.unread, 0);

  return (
    <div className="p-inbox p-rise" data-open={current !== undefined}>
      <div className="p-inbox-list">
        <div className="p-inbox-head">
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h1 className="p-inbox-title">Chats</h1>
            <span className="p-muted" style={{ fontSize: 12.5 }}>
              {unread === 0 ? `${threads.length} clients` : `${unread} unread`}
            </span>
          </div>
          {threads.length > 4 ? (
            <>
              <label className="sr-only" htmlFor="inbox-search">
                Search conversations
              </label>
              <input
                id="inbox-search"
                className="p-inbox-search"
                type="search"
                value={query}
                maxLength={100}
                placeholder="Search clients"
                onChange={(event) => setQuery(event.target.value)}
              />
            </>
          ) : null}
        </div>
        {shown.length === 0 ? (
          <p className="p-muted" style={{ margin: 0, padding: '20px 16px', fontSize: 13.5 }}>
            Nobody matches “{query}”.
          </p>
        ) : (
          <ThreadList
            threads={shown}
            selectedId={current?.id ?? null}
            meId={chat.state.meId}
            onSelect={(id) => select(id)}
          />
        )}
      </div>

      <div className="p-inbox-thread">
        {current === undefined ? (
          <div className="p-inbox-blank">
            <strong>Pick a conversation</strong>
            <span>Choose a client on the left to read and reply.</span>
          </div>
        ) : (
          <ChatPanel
            key={current.id}
            threadId={current.id}
            embedded
            height={null}
            title={
              <ChatHeader
                party={otherParty(current)}
                subtitle={current.writable ? 'Your client' : 'Coaching ended · read-only'}
                onBack={() => select(null)}
                actions={
                  <Link
                    href={`/portal/coaching/members/${current.member.id}#progress`}
                    className="p-btn p-btn-ghost p-btn-sm"
                  >
                    Client profile
                  </Link>
                }
              />
            }
          />
        )}
      </div>
    </div>
  );
}
