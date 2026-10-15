'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { PERMISSIONS, registerOpensAt } from '@got/shared';
import { LinkedAnnouncementsSection } from '@/components/announcements/LinkedAnnouncementsSection';
import { useChat, useNavBadges } from '@/components/chat/RealtimeProvider';
import { useMe, usePermission } from '@/components/rbac/MeProvider';
import { Badge, Card, CardHead, EmptyState, Skeleton } from '@/components/portal/ui';
import { OwnCoachProfileCard } from '@/components/portal/OwnCoachProfileCard';
import { ClassRegisterList } from '@/components/schedule/ClassRegisterList';
import { CoachSessionSheet } from '@/components/schedule/CoachSessionSheet';
import { WeekTimeGrid, type BlockTone } from '@/components/schedule/WeekTimeGrid';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { messagesBadge } from '@/lib/chat/badge';
import { initialsOf } from '@/lib/chat/format';
import {
  coachApi,
  type CoachMemberRow,
  type CoachSession,
  type CoachSummary,
} from '@/lib/coachApi';
import { greeting } from '@/lib/dashboard/dashboardView';
import { formatCivilDate } from '@/lib/gymTime';
import { dayRange, gymClock12, gymParts, mondayOf, shiftDay } from '@/lib/schedule/gymClock';
import { shortDay } from '@/lib/schedule/labels';
import { useIsPhone } from '@/lib/useMediaQuery';
import { cn } from '@/lib/utils';
import { StatsRow } from './StatsRow';

/**
 * The coach's dashboard — what `/portal/dashboard` renders for a coach.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE DASHBOARD, NOT TWO (owner, 2026-10-06).
 *
 * A coach used to have the member dashboard ("No active plan", check-ins, a
 * member code — none of it theirs) AND a separate Coach Dashboard. Now the one
 * Dashboard row is this, and `/portal/coaching` redirects here.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Laid out for the job, in the order a shift needs it, and to the width it is
 * given (a container query, like the member dashboard):
 *   - the band: who is in today and the two things to do next;
 *   - four numbers;
 *   - main column: today's register and the week as a time-grid. The
 *     register is the only thing here that WRITES, and it is one component
 *     (`ClassRegisterList`) in two places: under "Today", and in the session
 *     sheet the grid opens — for any class whose register has opened, past
 *     days included, so a register missed yesterday can still be put right;
 *   - side column: clients at a glance, the gym's noticeboard, and the
 *     profile members read.
 *
 * The full client table that used to sit here is the My Clients page now —
 * this shows the few a coach glances at, with a way through to the rest.
 */
export function CoachDashboard() {
  const { me } = useMe();
  const canChat = usePermission(PERMISSIONS.CHAT_USE);
  const badges = useNavBadges();
  const chat = useChat();
  const isPhone = useIsPhone();

  const [summary, setSummary] = useState<CoachSummary | null>(null);
  const [sessions, setSessions] = useState<CoachSession[] | null>(null);
  const [members, setMembers] = useState<CoachMemberRow[] | null>(null);
  const [now, setNow] = useState(() => new Date());
  const todayDay = gymParts(now).date;
  /** First visible day; null until the summary says which week "this week" is. */
  const [weekFirst, setWeekFirst] = useState<string | null>(null);
  /** Fetched on its own, so paging the grid to next week never hides today's register. */
  const [todaySessions, setTodaySessions] = useState<CoachSession[]>([]);
  /**
   * The session open in the sheet, AS IT WAS OPENED. What the sheet shows is
   * looked up by its id in the latest fetch (below), so after a mark reloads
   * the dashboard it shows the new "marked" count — and falls back to this
   * object when the latest fetch does not have it. A refetch that fails after
   * a mark (a 429, the network) empties the week, and a sheet that followed
   * the fetch alone vanished mid-register, then reopened by itself when a
   * later fetch brought the session back.
   */
  const [opened, setOpened] = useState<CoachSession | null>(null);
  /**
   * Bumped by a mark made in the sheet. Today's class can be open in the sheet
   * and under "Today" at once, and the "Today" copy must not come back from
   * behind the sheet showing the marks as they were before it opened.
   */
  const [todayRegisterVersion, setTodayRegisterVersion] = useState(0);
  /**
   * `forbidden` is its own state: a 403 means "not a coach", which is a
   * different sentence from "the network is down".
   */
  const [gate, setGate] = useState<'loading' | 'ok' | 'forbidden' | 'failed'>('loading');
  /** The gym day whose classes are on screen — moved only by a load that LANDED. */
  const loadedDay = useRef(todayDay);

  const reload = useCallback(async (): Promise<void> => {
    const day = gymParts(new Date()).date;
    const [summaryResult, membersResult, todayResult] = await Promise.all([
      coachApi.summary(),
      coachApi.members(),
      coachApi.schedule({ from: day, to: day }),
    ]);
    setSummary(summaryResult);
    setMembers(membersResult);
    setTodaySessions(todayResult);
    loadedDay.current = day;
    setNow(new Date());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void reload()
      .then(() => {
        if (!cancelled) setGate('ok');
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setGate(caught instanceof ApiError && caught.status === 403 ? 'forbidden' : 'failed');
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  // The clock TICKS. Registers open 30 minutes before a class, and this page
  // sits open through a whole shift: a clock that only moved on reload left
  // "Open register" disabled, and the grid's live block unlit, long after the
  // register had opened.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // ...and a dashboard left open past midnight fetches the new day, so the
  // band and the "Today" card never describe yesterday's classes as today's.
  //
  // Retried on every tick until it lands: `loadedDay` moves only inside a
  // reload that succeeded, and `now` is a dependency for its tick alone. It
  // used to move BEFORE the fetch, so one failure — a tablet asleep or
  // offline at midnight — left "Today" on yesterday's classes all day.
  const dayReloading = useRef(false);
  useEffect(() => {
    if (loadedDay.current === todayDay || dayReloading.current) return;
    dayReloading.current = true;
    reload()
      .catch(() => undefined)
      .finally(() => {
        dayReloading.current = false;
      });
  }, [now, todayDay, reload]);

  const weekLength = isPhone ? 3 : 7;
  const first = weekFirst ?? (isPhone ? todayDay : (summary?.weekFrom ?? mondayOf(todayDay)));

  // The grid reloads on its own when the visible days change, so paging does
  // not re-fetch the caseload.
  useEffect(() => {
    if (gate !== 'ok' && gate !== 'loading') return;
    if (summary === null) return;
    let cancelled = false;
    void coachApi
      .schedule({ from: first, to: shiftDay(first, weekLength - 1) })
      .then((rows) => {
        if (!cancelled) setSessions(rows);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [gate, summary, first, weekLength]);

  /** Unread per member, from the threads where the caller is the coach. */
  const unreadByMember = useMemo(() => {
    const map = new Map<string, number>();
    for (const thread of Object.values(chat?.state.threads ?? {})) {
      if (thread.role === 'COACH') map.set(thread.member.id, thread.unread);
    }
    return map;
  }, [chat?.state.threads]);

  if (gate === 'forbidden') {
    return (
      <Card>
        <EmptyState
          title="This page is for coaches"
          hint="Your account is not assigned as a coach. If that is wrong, the front desk can check it."
        />
      </Card>
    );
  }

  if (gate === 'failed') {
    return (
      <Card>
        <EmptyState
          title="Could not load your dashboard"
          hint="This is usually the network. Reload the page to try again."
        />
      </Card>
    );
  }

  if (gate === 'loading' || summary === null) {
    return (
      <div className="grid gap-5" aria-busy="true" aria-label="Loading your dashboard">
        <Skeleton height={168} />
        <Skeleton height={92} />
        <Skeleton height={320} />
      </div>
    );
  }

  const days = dayRange(first, weekLength);
  const detail =
    opened === null
      ? null
      : (sessions?.find((s) => s.id === opened.id) ??
        todaySessions.find((s) => s.id === opened.id) ??
        opened);
  const live = todaySessions.filter((s) => s.cancelledAt === null);
  const inGymNow = (members ?? []).filter((m) => m.inGymNow).length;
  const unread = badges.chatAsCoach ?? 0;

  const describe = (session: CoachSession) => {
    const markable = now.getTime() >= registerOpensAt(session.startsAt).getTime();
    const cancelled = session.cancelledAt !== null;
    const tone: BlockTone = cancelled
      ? 'cancelled'
      : session.businessDate === todayDay && markable
        ? 'coach-live'
        : 'coach';
    const detailText = cancelled
      ? 'Cancelled'
      : `${session.bookedCount}/${session.capacity} booked${markable ? ` · ${session.marked} marked` : ''}`;
    return {
      title: session.title,
      detail: detailText,
      tone,
      label: `${session.title}, ${shortDay(session.businessDate)} ${gymClock12(session.startsAt)}, ${detailText}`,
    };
  };

  /**
   * After a mark: the counts follow in the background. The mark itself has
   * already landed and shows on its row, so a failed refetch here is not news
   * — the open sheet keeps its session (see `opened`) and the next mark or the
   * next day's reload tries again.
   */
  const refreshCounts = (): void => {
    reload().catch(() => undefined);
  };

  const scrollToRegister = (): void => {
    document
      .getElementById('today-register')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="@container">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        {/* ── The band ── */}
        <section
          aria-labelledby="coach-greeting"
          className="p-card p-rise overflow-hidden bg-[linear-gradient(135deg,#fff_0%,#f7f6f3_100%)]"
        >
          <div className="flex flex-col gap-5 p-5 @3xl:flex-row @3xl:items-end @3xl:justify-between @xl:p-7">
            <div className="min-w-0">
              <h1 id="coach-greeting" className="p-h1">
                <span className="mb-1 block font-sans text-[13px] font-normal tracking-normal text-muted-foreground">
                  {greeting(now)},
                </span>
                {me?.firstName ?? 'Coach'}
              </h1>
              <p className="m-0 mt-3 max-w-[62ch] text-[14px] leading-relaxed text-ink-2">
                {live.length === 0 ? (
                  'No classes for you today.'
                ) : (
                  <>
                    <strong className="font-semibold text-foreground">
                      {live.length} {live.length === 1 ? 'class' : 'classes'} today
                    </strong>
                    {' — first at '}
                    {gymClock12(live[0]!.startsAt)}.
                  </>
                )}{' '}
                {inGymNow === 0
                  ? 'None of your clients is in the gym right now.'
                  : `${inGymNow} of your clients ${inGymNow === 1 ? 'is' : 'are'} in the gym now.`}
              </p>
            </div>

            <div className="flex flex-wrap gap-2.5">
              {live.length === 0 ? null : (
                <button
                  type="button"
                  className="p-btn p-btn-gold flex-1 @md:flex-none"
                  onClick={scrollToRegister}
                >
                  Take the register
                </button>
              )}
              {canChat ? (
                <Link
                  href="/portal/coaching/messages"
                  className="p-btn p-btn-ghost flex-1 text-foreground hover:text-gold-deep @md:flex-none"
                  aria-label={`Messages, ${messagesBadge(unread).spoken}`}
                >
                  Messages
                  {messagesBadge(unread).text === null ? null : (
                    <span className="p-nav-badge" aria-hidden>
                      {messagesBadge(unread).text}
                    </span>
                  )}
                </Link>
              ) : null}
              <Link
                href="/portal/coaching/clients"
                className="p-btn p-btn-ghost flex-1 text-foreground hover:text-gold-deep @md:flex-none"
              >
                My clients
              </Link>
            </div>
          </div>
        </section>

        <StatsRow
          tiles={[
            { label: 'Clients assigned', value: String(summary.assignedMembers) },
            { label: 'Classes this week', value: String(summary.sessionsThisWeek) },
            { label: 'Sessions today', value: String(summary.sessionsToday) },
            {
              label: 'Register marked today',
              value:
                summary.bookedToday === 0 ? '—' : `${summary.markedToday}/${summary.bookedToday}`,
            },
          ]}
        />

        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 @5xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
          {/* ── Main column ── */}
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
            <div id="today-register" className="scroll-mt-20">
              <TodayRegister
                sessions={todaySessions}
                now={now}
                version={todayRegisterVersion}
                onMarked={refreshCounts}
              />
            </div>

            <section aria-labelledby="coach-week" className="grid gap-3">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h2
                    id="coach-week"
                    className="m-0 font-display text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-3"
                  >
                    My schedule
                  </h2>
                  <p className="m-0 mt-1 font-display text-base font-semibold">
                    {shortDay(days[0] as string)} – {shortDay(days[days.length - 1] as string)}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Earlier"
                    onClick={() => setWeekFirst(shiftDay(first, -weekLength))}
                  >
                    ‹
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setWeekFirst(null)}>
                    This week
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Later"
                    onClick={() => setWeekFirst(shiftDay(first, weekLength))}
                  >
                    ›
                  </Button>
                </div>
              </div>

              {sessions === null ? (
                <Skeleton height={320} />
              ) : sessions.length === 0 ? (
                <Card>
                  <EmptyState
                    title="No classes this week"
                    hint="Sessions are created by an admin on the console, with you named as the coach."
                  />
                </Card>
              ) : (
                <WeekTimeGrid
                  days={days}
                  today={todayDay}
                  now={now}
                  events={sessions}
                  hourHeight={isPhone ? 40 : 44}
                  describe={describe}
                  onSelect={(session) => setOpened(session)}
                />
              )}

              <p className="m-0 text-xs text-ink-3">
                Registers open 30 minutes before a class starts. Tap a session for its details and
                its register — earlier days too.
              </p>
            </section>
          </div>

          {/* ── Side column ── */}
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
            <ClientsGlance members={members} unreadByMember={unreadByMember} canChat={canChat} />

            {/* The bell's rows land here for a coach (?notice=). The Suspense
                is load-bearing: the section reads ?notice= with useSearchParams. */}
            <Suspense fallback={<Skeleton height={160} />}>
              <LinkedAnnouncementsSection />
            </Suspense>

            {/* Staff & Access: what their members read about them, read-only. */}
            <OwnCoachProfileCard />
          </div>
        </div>
      </div>

      <CoachSessionSheet
        session={detail}
        now={now}
        side={isPhone ? 'bottom' : 'right'}
        onClose={() => setOpened(null)}
        onMarked={() => {
          setTodayRegisterVersion((version) => version + 1);
          refreshCounts();
        }}
      />
    </div>
  );
}

/** Relative, and deliberately coarse — a coach wants "3 days ago", not a date. */
function sinceLabel(iso: string | null): string {
  if (iso === null) return 'No visits yet';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'In today';
  if (days === 1) return 'Last in yesterday';
  if (days < 30) return `Last in ${days} days ago`;
  return `Last in ${formatCivilDate(iso.slice(0, 10))}`;
}

const GLANCE_LIMIT = 6;

/**
 * The clients a coach glances at: who is in now first, then who wrote to
 * them, then everyone else by name. The whole caseload, with search, is the
 * My Clients page.
 */
function ClientsGlance({
  members,
  unreadByMember,
  canChat,
}: {
  members: CoachMemberRow[] | null;
  unreadByMember: Map<string, number>;
  canChat: boolean;
}) {
  const sorted = useMemo(() => {
    if (members === null) return null;
    return [...members].sort(
      (a, b) =>
        Number(b.inGymNow) - Number(a.inGymNow) ||
        (unreadByMember.get(b.userId) ?? 0) - (unreadByMember.get(a.userId) ?? 0) ||
        `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`),
    );
  }, [members, unreadByMember]);

  return (
    <Card padded={false}>
      <div className="px-[18px] pt-[18px]">
        <CardHead
          title="My clients"
          action={
            members === null || members.length === 0 ? null : (
              <Link
                href="/portal/coaching/clients"
                className="text-[12.5px] font-semibold text-gold-deep no-underline hover:underline"
              >
                All {members.length}
              </Link>
            )
          }
        />
      </div>

      {sorted === null ? (
        <div className="p-[18px]">
          <Skeleton height={140} />
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState
          title="No clients yet"
          hint="An admin assigns members to a coach from the console."
        />
      ) : (
        <ul className="m-0 list-none p-0 pb-2">
          {sorted.slice(0, GLANCE_LIMIT).map((member) => {
            const badge = messagesBadge(canChat ? (unreadByMember.get(member.userId) ?? 0) : 0);
            return (
              <li key={member.userId}>
                <Link
                  href={`/portal/coaching/members/${member.userId}`}
                  className={cn(
                    'flex min-h-[56px] items-center gap-3 px-[18px] py-2.5 text-foreground no-underline',
                    'transition-colors hover:bg-[#fffdf8] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-gold',
                  )}
                >
                  {member.avatarUrl === null ? (
                    <span className="p-avatar-sm" aria-hidden>
                      {initialsOf(member)}
                    </span>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className="p-avatar-sm"
                      src={member.avatarUrl}
                      alt=""
                      width={36}
                      height={36}
                    />
                  )}
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-[14px] font-semibold">
                      {member.firstName} {member.lastName}
                    </span>
                    <span className="truncate text-[12.5px] text-ink-3">
                      {sinceLabel(member.lastVisitAt)} · {member.visits30d} in 30 days
                    </span>
                  </span>
                  {member.inGymNow ? <Badge tone="ok">In now</Badge> : null}
                  {badge.text === null ? null : (
                    <span className="p-nav-badge" aria-label={badge.spoken}>
                      {badge.text}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/**
 * Today's sessions, each expanding to its register (`ClassRegisterList`, the
 * same register the session sheet opens for any day).
 *
 * `now` is the dashboard's ticking clock, passed down rather than kept here a
 * second time: one clock for the band, the grid, this card and the sheet.
 */
function TodayRegister({
  sessions,
  now,
  version,
  onMarked,
}: {
  sessions: CoachSession[];
  now: Date;
  /** Refetches an open register in the background — see `todayRegisterVersion`. */
  version: number;
  onMarked: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <Card padded={false}>
      <div className="px-[18px] pt-[18px]">
        <CardHead title="Today" />
      </div>

      {sessions.length === 0 ? (
        <EmptyState
          title="No classes for you today"
          hint="Your next sessions are in the schedule below."
        />
      ) : (
        <div className="grid gap-2.5 p-[18px]">
          {sessions.map((session) => {
            const cancelled = session.cancelledAt !== null;
            // Never open on a cancelled class, even one opened before the gym
            // called it off and the reload brought the news.
            const expanded = openId === session.id && !cancelled;
            return (
              <div
                key={session.id}
                className="overflow-hidden rounded-[var(--p-radius)] border border-border"
              >
                <div className="flex flex-wrap items-center gap-3 px-[15px] py-[13px]">
                  <span className="min-w-0">
                    <strong className="text-[14.5px]">{session.title}</strong>
                    <span className="mt-0.5 block text-[12.5px] text-ink-3">
                      {gymClock12(session.startsAt)} – {gymClock12(session.endsAt)} ·{' '}
                      {session.bookedCount} booked
                    </span>
                  </span>

                  <span className="ml-auto flex items-center gap-2">
                    {cancelled ? (
                      <Badge tone="danger">Cancelled</Badge>
                    ) : session.marked >= session.bookedCount && session.bookedCount > 0 ? (
                      <Badge tone="ok">All marked</Badge>
                    ) : (
                      <Badge tone="warn">
                        {session.marked}/{session.bookedCount} marked
                      </Badge>
                    )}
                    {cancelled ? null : (
                      <button
                        type="button"
                        className="p-btn p-btn-ghost p-btn-sm"
                        onClick={() => setOpenId(expanded ? null : session.id)}
                        aria-expanded={expanded}
                      >
                        {expanded ? 'Hide register' : 'Take register'}
                      </button>
                    )}
                  </span>
                </div>

                {expanded ? (
                  <div className="border-t border-border px-[15px] py-3">
                    <ClassRegisterList
                      key={session.id}
                      session={session}
                      now={now}
                      version={version}
                      onMarked={onMarked}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
