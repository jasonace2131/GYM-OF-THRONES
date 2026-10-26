'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { PERMISSIONS } from '@got/shared';
import { Badge, Card, CardHead } from '@/components/portal/ui';
import { DataState, Pager } from '@/components/admin/ui';
import { RequirePermission } from '@/components/rbac/guards';
import { ApiError } from '@/lib/api';
import { gymDateTime } from '@/lib/adminApi';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { chatReviewApi, type ThreadReview } from '@/lib/chat/chatReviewApi';

/**
 * Chat review — reading a coach-member conversation for a COMPLAINT
 * (feat/coach-tools, `chat.review`, ADMIN at ALL).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOT MONITORING. The list shows who has talked to whom and when — no text.
 * Opening a conversation asks why, and the server writes that reason, the
 * admin and the time to the audit log (CHAT_THREAD_REVIEWED) on EVERY read.
 * The transcript includes messages the sender withdrew, flagged as such,
 * because a complaint may turn on exactly those.
 *
 * Text is rendered as plain text, never as HTML.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const PAGE_SIZE = 20;

export default function ChatReviewPage() {
  return (
    <RequirePermission permission={PERMISSIONS.CHAT_REVIEW} scope="ALL">
      <ChatReview />
    </RequirePermission>
  );
}

function ChatReview() {
  const [page, setPage] = useState(1);
  const [asking, setAsking] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [review, setReview] = useState<ThreadReview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const threads = useAdminQuery(
    useCallback(() => chatReviewApi.threads({ page, limit: PAGE_SIZE }), [page]),
    `chat-review:${page}`,
  );

  const open = async (threadId: string): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      setReview(await chatReviewApi.review(threadId, reason.trim()));
      setAsking(null);
      setReason('');
    } catch (caught) {
      setFailure(
        caught instanceof ApiError ? caught.message : 'That conversation could not be opened.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (review !== null) {
    const { thread } = review;
    const who = (senderId: string): string =>
      senderId === thread.coach.id
        ? `${thread.coach.firstName} (coach)`
        : senderId === thread.member.id
          ? `${thread.member.firstName} (member)`
          : 'Unknown';
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <Card>
          <CardHead
            title={`${thread.coach.firstName} ${thread.coach.lastName} ↔ ${thread.member.firstName} ${thread.member.lastName}`}
            action={
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                onClick={() => setReview(null)}
              >
                Close
              </button>
            }
          />
          <p className="p-muted" style={{ margin: '10px 0 0', fontSize: 12.5 }}>
            This read has been recorded in the audit log with your reason.
          </p>
        </Card>

        <Card padded={false}>
          <div style={{ padding: 18, display: 'grid', gap: 12 }}>
            {review.messages.length === 0 ? (
              <p className="p-muted" style={{ margin: 0 }}>
                No messages.
              </p>
            ) : (
              review.messages.map((message) => (
                <div
                  key={message.id}
                  style={{
                    display: 'grid',
                    gap: 4,
                    paddingBottom: 12,
                    borderBottom: '1px solid var(--p-border)',
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>{who(message.senderId)}</strong>
                    <span className="p-muted" style={{ fontSize: 12 }}>
                      {gymDateTime(message.createdAt)}
                    </span>
                    {message.deletedAt === null ? null : (
                      <Badge tone="warn">Withdrawn {gymDateTime(message.deletedAt)}</Badge>
                    )}
                  </div>
                  <div style={{ fontSize: 14, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {message.body}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <Card>
        <CardHead
          title="Chat review"
          action={
            <Link href="/admin/coaches" className="p-btn p-btn-ghost p-btn-sm">
              Coaches
            </Link>
          }
        />
        <p className="p-muted" style={{ margin: '10px 0 0', fontSize: 13, lineHeight: 1.6 }}>
          For complaints only. Opening a conversation asks for a reason and records it, with your
          name and the time, in the audit log. The list below shows no message text.
        </p>
      </Card>

      <Card padded={false}>
        <DataState
          loading={threads.loading}
          error={threads.error}
          empty={(threads.data?.items.length ?? 0) === 0}
          emptyTitle="No conversations yet"
          emptyHint="Conversations appear here once a coach or a member has written in one."
          onRetry={threads.reload}
        >
          <div style={{ padding: '0 18px 18px' }}>
            <div className="a-scroll">
            <table className="p-table" data-stack>
              <thead>
                <tr>
                  <th>Coach</th>
                  <th>Member</th>
                  <th className="p-num">Messages</th>
                  <th>Last message</th>
                  <th>
                    <span className="sr-only">Review</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(threads.data?.items ?? []).map((row) => (
                  <tr key={row.id}>
                    <td data-label="Coach" data-card="title">
                      {row.coach.firstName} {row.coach.lastName}
                    </td>
                    <td data-label="Member">
                      {row.member.firstName} {row.member.lastName}
                    </td>
                    <td className="p-num" data-label="Messages">
                      {row.messageCount}
                    </td>
                    <td className="p-muted" data-label="Last message">
                      {row.lastMessageAt === null ? '—' : gymDateTime(row.lastMessageAt)}
                    </td>
                    <td className="a-cell-actions" data-card="actions">
                      {asking === row.id ? (
                        <form
                          className="a-review-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void open(row.id);
                          }}
                        >
                          <label style={{ display: 'grid', gap: 4, textAlign: 'left' }}>
                            <span className="a-person-sub">WHY ARE YOU READING THIS?</span>
                            <input
                              className="a-input"
                              value={reason}
                              maxLength={500}
                              placeholder="Complaint reference or reason"
                              autoFocus
                              onChange={(event) => setReason(event.target.value)}
                            />
                          </label>
                          {failure === null ? null : (
                            <span role="alert" style={{ fontSize: 12.5, color: 'var(--p-danger)' }}>
                              {failure}
                            </span>
                          )}
                          <span className="a-btn-row a-btn-row--end">
                            <button
                              type="button"
                              className="p-btn p-btn-ghost p-btn-sm"
                              onClick={() => {
                                setAsking(null);
                                setReason('');
                                setFailure(null);
                              }}
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              className="p-btn p-btn-gold p-btn-sm"
                              disabled={busy || reason.trim().length < 5}
                            >
                              Open and record
                            </button>
                          </span>
                        </form>
                      ) : (
                        <button
                          type="button"
                          className="p-btn p-btn-ghost p-btn-sm"
                          onClick={() => {
                            setAsking(row.id);
                            setReason('');
                            setFailure(null);
                          }}
                        >
                          Review
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {threads.data !== null ? (
              <Pager page={page} limit={PAGE_SIZE} total={threads.data.total} onPage={setPage} />
            ) : null}
          </div>
        </DataState>
      </Card>
    </div>
  );
}
