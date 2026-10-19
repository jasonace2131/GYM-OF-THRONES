'use client';

import { useEffect, useState } from 'react';
import { PERMISSIONS } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import { usePermission } from '@/components/rbac/MeProvider';
import { useChat } from '@/components/chat/RealtimeProvider';
import { ChatHeader, ChatPanel } from '@/components/chat/ChatPanel';
import { apiFetch } from '@/lib/api';
import { sortedThreads } from '@/lib/chat/chatState';
import { Badge, Card, CardHead, EmptyState, Skeleton } from '@/components/portal/ui';
import { formatGymTime } from '@/lib/gymTime';

/**
 * My Coach.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS SCREEN USED TO INVENT PEOPLE.
 *
 * It rendered three coaches who do not work here, "online" dots that tracked
 * nothing, and a message thread that never happened — out of `portalData.ts`,
 * a file whose own header says "Nothing here may hold FABRICATED data any
 * more". A member reading a conversation they never had is the single worst
 * thing this portal could show them.
 *
 * It now reads `GET /me/coach`: the real assignment from `CoachAssignment`,
 * or nothing. Most members have no coach, and that is a renderable state.
 *
 * Messaging is REAL now (feat/coach-tools): the Chat panel below is the
 * member's thread with their coach, saved in our database and pushed live
 * over Supabase Realtime. It says so plainly when there is no chat to have —
 * no coach, a member under 18 (owner decision: no 1:1 chat for minors), or a
 * coaching that ended (its history stays, read-only).
 * ═══════════════════════════════════════════════════════════════════════════
 */

const TZ = 'Asia/Manila';

interface MyCoach {
  coach: { firstName: string; lastName: string; avatarUrl: string | null } | null;
  /**
   * Staff & Access: what the coach specialises in, and a short bio, as an
   * admin wrote it. Null when nobody has — then the card says nothing about
   * it rather than rendering an empty box. Optional in the type so a browser
   * holding this bundle survives an API that predates it.
   */
  profile?: { specializations: string[]; bio: string | null } | null;
  since: string | null;
  upcomingClasses: {
    id: string;
    title: string;
    startsAt: string;
    endsAt: string;
    capacity: number;
    bookedCount: number;
  }[];
}

function day(iso: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
}

/**
 * A member's own section: `coach.self`, which only CLIENT holds. For a coach
 * the nav offers "My Clients" (their caseload) instead (owner decision,
 * 2026-09-25).
 */
export default function CoachPage() {
  return (
    <RequirePermission permission={PERMISSIONS.COACH_SELF}>
      <MyCoachCard />
    </RequirePermission>
  );
}

function MyCoachCard() {
  const [data, setData] = useState<MyCoach | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<MyCoach>('/me/coach')
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return (
      <EmptyState
        title="We could not load your coach"
        hint="Check your connection and refresh. The front desk can always tell you who you are assigned to."
      />
    );
  }

  if (data === null) return <Skeleton height={220} />;

  if (data.coach === null) {
    return (
      <div style={{ display: 'grid', gap: 16, maxWidth: 760 }}>
        <Card>
          <EmptyState
            title="No coach assigned yet"
            hint="Ask at the front desk about personal coaching they can assign one to your account."
          />
        </Card>
        {/* A coaching that ENDED leaves its conversation as read-only history. */}
        <CoachChat coachFirstName={null} />
      </div>
    );
  }

  const name = `${data.coach.firstName} ${data.coach.lastName}`.trim();
  const initials = `${data.coach.firstName[0] ?? ''}${data.coach.lastName[0] ?? ''}`.toUpperCase();

  // Who coaches me on the left, the conversation beside it filling the
  // height (owner, 2026-10-06: the chat sat centred and cramped on wide
  // screens). Below 1180px it stacks with the conversation first.
  return (
    <div className="p-mycoach">
      <div className="p-mycoach-side">
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {data.coach.avatarUrl === null ? (
              <span
                aria-hidden
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  background: 'var(--p-paper2)',
                  border: '1px solid var(--p-border)',
                  fontWeight: 700,
                  fontSize: 18,
                }}
              >
                {initials}
              </span>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={data.coach.avatarUrl}
                alt=""
                width={56}
                height={56}
                style={{ borderRadius: '50%', objectFit: 'cover' }}
              />
            )}
            <div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{name}</div>
              <div className="p-muted" style={{ fontSize: 13 }}>
                Your coach{data.since === null ? '' : ` since ${day(data.since)}`}
              </div>
            </div>
          </div>
          {data.profile === undefined || data.profile === null ? null : (
            <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
              {data.profile.specializations.length === 0 ? null : (
                <div
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
                  aria-label={`${data.coach.firstName} specialises in`}
                >
                  {data.profile.specializations.map((tag) => (
                    <Badge key={tag} tone="info">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
              {data.profile.bio === null ? null : (
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--p-ink2)' }}>
                  {data.profile.bio}
                </p>
              )}
            </div>
          )}
          <p className="p-muted" style={{ fontSize: 13.5, lineHeight: 1.6, margin: '14px 0 0' }}>
            Message {data.coach.firstName} here, speak to them at the gym, or leave a message with
            the front desk.
          </p>
        </Card>

        <Card padded={false}>
          <div style={{ padding: '16px 16px 0' }}>
            <CardHead title={`${data.coach.firstName}'s next sessions`} />
          </div>
          {data.upcomingClasses.length === 0 ? (
            <div style={{ padding: 16 }}>
              <span className="p-muted" style={{ fontSize: 13.5 }}>
                No sessions scheduled yet. Check the class schedule for the full timetable.
              </span>
            </div>
          ) : (
            <div style={{ padding: '4px 16px 16px', display: 'grid', gap: 10 }}>
              {data.upcomingClasses.map((session) => (
                <div
                  key={session.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    paddingTop: 10,
                    borderTop: '1px solid var(--p-border)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{session.title}</div>
                    <div className="p-muted" style={{ fontSize: 12.5 }}>
                      {day(session.startsAt)} · {formatGymTime(session.startsAt, TZ)}
                    </div>
                  </div>
                  <span className="p-muted" style={{ marginLeft: 'auto', fontSize: 12.5 }}>
                    {Math.max(0, session.capacity - session.bookedCount)} seats left
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="p-mycoach-chat">
        <CoachChat coachFirstName={data.coach.firstName} />
      </div>
    </div>
  );
}

/**
 * The member's side of the coach chat.
 *
 * Three honest states before any conversation: chat is not theirs to use
 * (`chat.use`), they are under 18 (closed, owner decision), or they have no
 * coach. A coaching that ended keeps its conversation as read-only history,
 * opened one at a time — each open conversation is the one the chat state
 * treats as "on screen".
 */
function CoachChat({ coachFirstName }: { coachFirstName: string | null }) {
  const chat = useChat();
  const canChat = usePermission(PERMISSIONS.CHAT_USE);
  const [openHistory, setOpenHistory] = useState<string | null>(null);

  if (!canChat || chat === null) return null;
  if (!chat.state.loaded) return <Skeleton height={320} />;

  if (chat.state.minor) {
    return (
      <Card>
        <EmptyState
          title="Coach chat isn't available for members under 18"
          hint="Talk to your coach at the gym, or leave a message with the front desk."
        />
      </Card>
    );
  }

  const threads = sortedThreads(chat.state, 'MEMBER');
  const current = coachFirstName === null ? undefined : threads.find((t) => t.writable);
  const ended = threads.filter((t) => !t.writable && t.lastMessage !== null);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {coachFirstName === null ? null : current === undefined ? (
        <Card>
          <EmptyState
            title="Chat isn't open yet"
            hint={`Your conversation with ${coachFirstName} opens here once your coaching is set up. Reload in a moment, or ask at the front desk.`}
          />
        </Card>
      ) : (
        <ChatPanel
          key={current.id}
          threadId={current.id}
          height={null}
          title={<ChatHeader party={current.coach} subtitle="Your coach" />}
        />
      )}

      {ended.length > 0 ? (
        <Card padded={false}>
          <div style={{ padding: '16px 16px 0' }}>
            <CardHead title="Earlier conversations" />
          </div>
          <div style={{ padding: '4px 16px 16px', display: 'grid', gap: 10 }}>
            {ended.map((thread) => (
              <div key={thread.id} style={{ display: 'grid', gap: 10 }}>
                <button
                  type="button"
                  className="p-btn p-btn-ghost p-btn-sm"
                  style={{ justifySelf: 'start' }}
                  aria-expanded={openHistory === thread.id}
                  onClick={() => setOpenHistory(openHistory === thread.id ? null : thread.id)}
                >
                  {openHistory === thread.id ? 'Hide' : 'Show'} your chat with{' '}
                  {thread.coach.firstName} {thread.coach.lastName}
                </button>
                {openHistory === thread.id ? (
                  <ChatPanel
                    threadId={thread.id}
                    height="min(60vh, 520px)"
                    title={
                      <ChatHeader party={thread.coach} subtitle="Coaching ended · read-only" />
                    }
                  />
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
