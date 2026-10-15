'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PERMISSIONS } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import { usePermission } from '@/components/rbac/MeProvider';
import { useChat } from '@/components/chat/RealtimeProvider';
import { coachApi, type CoachMemberRow } from '@/lib/coachApi';
import { messagesBadge } from '@/lib/chat/badge';
import { initialsOf } from '@/lib/chat/format';
import { formatCivilDate } from '@/lib/gymTime';
import { Badge, Card, CardHead, EmptyState, Skeleton } from '@/components/portal/ui';

/**
 * MY CLIENTS — the coach's hub (feat/coach-tools; "My Coach" for a member,
 * "My Clients (chatbox)" for a coach).
 *
 * One card per ACTIVELY assigned client (`GET /me/coaching/members`, the same
 * caseload the dashboard shows), each opening straight onto that client's
 * Progress · Workout plan · Chat, with the chat's unread count on it. The
 * counts come from the one Realtime-fed chat state in the portal shell, so
 * they move as messages arrive.
 */
export default function MyClientsPage() {
  return (
    <RequirePermission permission={PERMISSIONS.COACH_READ}>
      <ClientsHub />
    </RequirePermission>
  );
}

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ok'; rows: CoachMemberRow[] };

function ClientsHub() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [query, setQuery] = useState('');
  const chat = useChat();
  const canChat = usePermission(PERMISSIONS.CHAT_USE);
  const canPlan = usePermission(PERMISSIONS.WORKOUT_MANAGE);

  useEffect(() => {
    let cancelled = false;
    coachApi.members().then(
      (rows) => {
        if (!cancelled) setLoad({ state: 'ok', rows });
      },
      () => {
        if (!cancelled) setLoad({ state: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /** Unread per member, from the threads where the caller is the coach. */
  const unreadByMember = useMemo(() => {
    const map = new Map<string, number>();
    for (const thread of Object.values(chat?.state.threads ?? {})) {
      if (thread.role === 'COACH') map.set(thread.member.id, thread.unread);
    }
    return map;
  }, [chat?.state.threads]);

  if (load.state === 'loading') {
    return (
      <div style={{ display: 'grid', gap: 14 }}>
        <Skeleton height={60} />
        <Skeleton height={220} />
      </div>
    );
  }

  if (load.state === 'failed') {
    return (
      <Card>
        <EmptyState
          title="Could not load your clients"
          hint="This is usually the network. Reload the page to try again."
        />
      </Card>
    );
  }

  const needle = query.trim().toLowerCase();
  const rows = load.rows.filter(
    (row) =>
      needle === '' ||
      `${row.firstName} ${row.lastName}`.toLowerCase().includes(needle) ||
      (row.memberCode ?? '').toLowerCase().includes(needle),
  );

  return (
    <div style={{ display: 'grid', gap: 18 }} className="p-rise">
      <Card padded={false}>
        <div style={{ padding: '18px 18px 0' }}>
          <CardHead
            title="My clients"
            action={
              <span className="p-muted" style={{ fontSize: 12.5 }}>
                {load.rows.length} assigned
              </span>
            }
          />
        </div>
        <div style={{ padding: '0 18px 18px', display: 'grid', gap: 14 }}>
          {load.rows.length > 6 ? (
            <label style={{ display: 'grid', gap: 5, maxWidth: 360 }}>
              <span className="a-person-sub">FIND A CLIENT</span>
              <input
                className="a-input"
                value={query}
                placeholder="Name or member code"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          ) : null}

          {load.rows.length === 0 ? (
            <EmptyState
              title="No clients assigned to you yet"
              hint="An admin assigns members to a coach from the console. Each member has at most one coach at a time."
            />
          ) : rows.length === 0 ? (
            <p className="p-muted" style={{ margin: 0 }}>
              Nobody matches “{query}”.
            </p>
          ) : (
            <div
              style={{
                display: 'grid',
                gap: 12,
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              }}
            >
              {rows.map((row) => (
                <ClientCard
                  key={row.userId}
                  row={row}
                  unread={unreadByMember.get(row.userId) ?? 0}
                  canChat={canChat}
                  canPlan={canPlan}
                />
              ))}
            </div>
          )}
        </div>
      </Card>

      <p className="p-muted" style={{ fontSize: 12, lineHeight: 1.6, margin: 0 }}>
        Chat is for the clients you coach now. When an assignment ends, the conversation stays as
        read-only history. Members under 18 have no 1:1 chat — they reach you through the front
        desk.
      </p>
    </div>
  );
}

function ClientCard({
  row,
  unread,
  canChat,
  canPlan,
}: {
  row: CoachMemberRow;
  unread: number;
  canChat: boolean;
  canPlan: boolean;
}) {
  const base = `/portal/coaching/members/${row.userId}`;
  const badge = messagesBadge(unread);
  return (
    <article
      style={{
        display: 'grid',
        gap: 12,
        padding: 14,
        border: '1px solid var(--p-border)',
        borderRadius: 12,
        background: 'var(--p-paper)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {row.avatarUrl === null ? (
          <span className="p-avatar-sm" aria-hidden>
            {initialsOf(row)}
          </span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="p-avatar-sm" src={row.avatarUrl} alt="" width={36} height={36} />
        )}
        <div style={{ minWidth: 0 }}>
          <Link href={base} style={{ color: 'inherit', textDecoration: 'none' }}>
            <strong>
              {row.firstName} {row.lastName}
            </strong>
          </Link>
          <div className="p-muted" style={{ fontSize: 12 }}>
            {row.memberCode ?? 'No member code yet'} · since{' '}
            {formatCivilDate(row.since.slice(0, 10))}
          </div>
        </div>
        {row.inGymNow ? (
          <span style={{ marginLeft: 'auto' }}>
            <Badge tone="ok">In now</Badge>
          </span>
        ) : null}
      </div>

      <div className="p-muted" style={{ fontSize: 12.5 }}>
        {row.visits30d} {row.visits30d === 1 ? 'visit' : 'visits'} in the last 30 days
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Link href={`${base}#progress`} className="p-btn p-btn-ghost p-btn-sm">
          Progress
        </Link>
        {canPlan ? (
          <Link href={`${base}#plan`} className="p-btn p-btn-ghost p-btn-sm">
            Workout plan
          </Link>
        ) : null}
        {canChat ? (
          <Link
            href={`${base}#chat`}
            className="p-btn p-btn-ghost p-btn-sm"
            aria-label={`Chat with ${row.firstName}, ${badge.spoken}`}
          >
            Chat
            {badge.text !== null ? (
              <span className="p-nav-badge" aria-hidden>
                {badge.text}
              </span>
            ) : null}
          </Link>
        ) : null}
      </div>
    </article>
  );
}
