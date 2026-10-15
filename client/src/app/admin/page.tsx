'use client';

import { Suspense, useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { PERMISSIONS } from '@got/shared';
import { DataState, Person, StandingBadge } from '@/components/admin/ui';
import { CheckInsChart } from '@/components/admin/dashboard/CheckInsChart';
import { RenewalsCalendar } from '@/components/admin/dashboard/RenewalsCalendar';
import { ManualCheckInModal } from '@/components/admin/actions/ManualCheckInModal';
import { WalkInModal } from '@/components/admin/actions/WalkInModal';
import { ShiftModal } from '@/components/admin/actions/ShiftModal';
import { adminApi, civilDate, gymTime, peso, duration } from '@/lib/adminApi';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { useMe, usePermission } from '@/components/rbac/MeProvider';
import { Can } from '@/components/rbac/guards';
import { LinkedAnnouncementsSection } from '@/components/announcements/LinkedAnnouncementsSection';
import { STAFF_QR_PATH } from '@/lib/stationAuth';

/**
 * The CRM dashboard — the command centre.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT ANSWERS THREE QUESTIONS, IN THIS ORDER.
 *
 *   1. What needs me right now?   → the "Needs you" band
 *   2. How is today going?        → the KPI row
 *   3. What is coming?            → chart, renewals calendar, expiring list
 *
 * Layout order follows that. Nothing is placed for visual balance.
 *
 * EVERY NUMBER IS REAL OR IT IS NOT SHOWN. No tips, no placeholders, no
 * targets nothing computes. A dashboard that mixes live figures with
 * plausible-looking filler is worse than a smaller one: staff cannot tell
 * which is which, and the first time somebody acts on a fake number the whole
 * screen loses its credibility.
 *
 * ICONS LIVE IN THE SIDEBAR AND INSIDE BUTTONS. Not on KPI tiles. An icon
 * beside "342" says nothing the word "Members" did not, and six of them in a
 * row turn a data surface into a sticker album. Colour is a signal here —
 * warn, danger — and never a finish.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** The live floor. Two requests per 30 s is 4 of the 100/60 s budget. */
const FLOOR_POLL_MS = 30_000;
/** Money and drawer state change at human speed. */
const TILL_POLL_MS = 60_000;
/** Beyond this, a visit is likely a forgotten check-out rather than a workout. */
const LONG_SESSION_MINUTES = 180;
const PAGE = 100;

/** The chart's selectable windows. */
const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

/**
 * The delta baseline is SEVEN DAYS BACK, so the series must always reach that
 * far even when the chart is showing a shorter window. Fetch at least eight
 * days and slice for display — one request, not two.
 */
const DELTA_LAG_DAYS = 7;
const MIN_FETCH_DAYS = DELTA_LAG_DAYS + 1;

function weekdayOf(day: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );
}

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Gym-local civil date, built from parts so it is never a UTC slice. */
function gymCivilDate(offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(Date.now() + offsetDays * 86_400_000));
  const at = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${at('year')}-${at('month')}-${at('day')}`;
}

export default function AdminDashboardPage() {
  const { me } = useMe();
  const today = gymCivilDate();
  /**
   * THE SHELL HIDES DOORS THIS PAGE WAS OPENING ANYWAY.
   *
   * `visibleNav` filters the sidebar on held keys, but the dashboard fired
   * `payments` and `currentShift` unconditionally — so a FRONT_DESK account
   * without `payment.read` got a guaranteed 403 per panel per poll, a till
   * tile rendering "—" that reads as "took nothing today" rather than "not
   * yours to see", and a server log full of denials that look like probing.
   */
  const canReadPayments = usePermission(PERMISSIONS.PAYMENT_READ);
  const canManageShift = usePermission(PERMISSIONS.SHIFT_MANAGE);
  // The two desk actions. Manual check-in and the walk-in sale are separate
  // grants — a COACH marking a register holds neither — and both buttons
  // rendered unconditionally until now.
  const canCheckIn = usePermission(PERMISSIONS.CHECKIN_CREATE);
  const canSellWalkIn = usePermission(PERMISSIONS.WALKIN_SELL);
  // Puts the member check-in code on screen from this login — the key the
  // station-token route checks on its staff path.
  const canShowQr = usePermission(PERMISSIONS.CHECKIN_STATION_TOKEN_ISSUE);
  const [action, setAction] = useState<'checkin' | 'walkin' | 'shift' | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [range, setRange] = useState<Range>(30);

  /* ── Data ────────────────────────────────────────────────────────────── */

  const desk = useAdminQuery(useCallback(() => adminApi.today(), []), 'desk-today', {
    pollMs: FLOOR_POLL_MS,
  });

  // limit=50, not 5. The table shows five, but the long-session counter below
  // filters this same list — and a limit of 5 would report "0 long sessions"
  // whenever the five most recent arrivals happen to be fresh, which is
  // exactly when somebody has been inside for four hours.
  const inGym = useAdminQuery(
    useCallback(() => adminApi.activeCheckIns({ limit: 50 }), []),
    'in-gym',
    { pollMs: FLOOR_POLL_MS },
  );

  const revenue = useAdminQuery(
    useCallback(() => adminApi.payments({ from: today, to: today, limit: 6 }), [today]),
    `revenue:${today}`,
    { pollMs: TILL_POLL_MS, enabled: canReadPayments },
  );

  const shift = useAdminQuery(useCallback(() => adminApi.currentShift(), []), 'shift', {
    pollMs: TILL_POLL_MS,
    enabled: canManageShift,
  });

  const members = useAdminQuery(
    useCallback(() => adminApi.members({ standing: 'ACTIVE', limit: 1 }), []),
    'member-count',
  );

  const expiring = useAdminQuery(
    useCallback(() => adminApi.memberships({ expiringWithinDays: 7, limit: 8 }), []),
    'expiring-week',
  );

  // The calendar needs the whole 90-day window, not a page. MAX_LIMIT is 100,
  // so a second page is fetched only when the first one filled.
  const renewals = useAdminQuery(
    useCallback(async () => {
      const first = await adminApi.memberships({ expiringWithinDays: 90, limit: PAGE });
      if (first.total <= PAGE) return first;
      const second = await adminApi.memberships({
        expiringWithinDays: 90,
        limit: PAGE,
        page: 2,
      });
      return { ...first, items: [...first.items, ...second.items] };
    }, []),
    'renewals-90',
  );

  const chart = useAdminQuery(
    useCallback(() => {
      const fetchDays = Math.max(range, MIN_FETCH_DAYS);
      return adminApi.checkInsDaily(gymCivilDate(-(fetchDays - 1)), gymCivilDate());
    }, [range]),
    `chart:${today}:${range}`,
  );

  /* ── Derived ─────────────────────────────────────────────────────────── */

  const counters = desk.data?.counters;

  /**
   * Week-on-week, against the SAME WEEKDAY — never yesterday. A gym's Monday
   * does not resemble its Sunday, so "vs yesterday" is noise dressed as a
   * trend. A bare "87" cannot be read at all; "87, up 12% on last Monday" is
   * a fact somebody can act on, which is the whole reason this tile exists.
   */
  const delta = useMemo(() => {
    const days = chart.data?.days;
    if (days === undefined || counters === undefined) return null;

    const baselineDate = gymCivilDate(-DELTA_LAG_DAYS);
    const baseline = days.find((d) => d.date === baselineDate);
    if (baseline === undefined) return null;

    const weekday = weekdayOf(baselineDate);
    // No division by zero, and no "+∞%" on the first busy day after a closure.
    if (baseline.total === 0) {
      return { weekday, text: `none last ${weekday}`, tone: null as string | null };
    }

    const pct = Math.round(((counters.today - baseline.total) / baseline.total) * 100);
    return {
      weekday,
      pct,
      text: `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}%`,
      tone: pct >= 0 ? 'ok' : 'danger',
    };
  }, [chart.data, counters]);

  /** Fetched window may be wider than the shown one — see MIN_FETCH_DAYS. */
  const chartShown = useMemo(() => {
    if (chart.data === null) return null;
    const days = chart.data.days.slice(-range);
    return { ...chart.data, days, from: days[0]?.date ?? chart.data.from };
  }, [chart.data, range]);

  const longSessions = useMemo(
    () => (inGym.data?.items ?? []).filter((row) => row.durationMinutes > LONG_SESSION_MINUTES),
    [inGym.data],
  );

  const attention = useMemo(() => {
    // The VERB is what makes this a queue rather than a list of complaints.
    const items: {
      key: string;
      tone: string;
      title: string;
      sub: string;
      href: string;
      verb: string;
    }[] = [];

    if (counters !== undefined && counters.needsYou > 0) {
      items.push({
        key: 'denials',
        tone: 'danger',
        title: `${counters.needsYou} denied scan${counters.needsYou === 1 ? '' : 's'}`,
        sub: 'Unresolved at the door',
        href: '/admin/attendance',
        verb: 'Resolve',
      });
    }
    if (expiring.data !== null && expiring.data.total > 0) {
      items.push({
        key: 'expiring',
        tone: 'warn',
        title: `${expiring.data.total} membership${expiring.data.total === 1 ? '' : 's'} expiring`,
        sub: 'Ending within seven days',
        // The roster, filtered to the call sheet and sorted in call order.
        // `/admin/subscriptions` merged into it.
        href: '/admin/members?standing=EXPIRING&sort=ending',
        verb: 'Call',
      });
    }
    if (longSessions.length > 0) {
      items.push({
        key: 'long',
        tone: 'info',
        title: `${longSessions.length} still in the gym`,
        sub: `Checked in over ${LONG_SESSION_MINUTES / 60} hours ago`,
        href: '/admin/attendance',
        verb: 'Check out',
      });
    }
    return items;
  }, [counters, expiring.data, longSessions]);

  // Clicking a day in the calendar filters the list below it rather than
  // navigating — the point is to answer "who do I call today" without losing
  // the rest of the page.
  const expiringRows = useMemo(() => {
    if (selectedDay === null) return expiring.data?.items ?? [];
    return (renewals.data?.items ?? []).filter((row) => row.endsOn === selectedDay);
  }, [selectedDay, expiring.data, renewals.data]);

  const refreshFloor = useCallback(() => {
    desk.reload();
    inGym.reload();
  }, [desk, inGym]);

  const refreshTill = useCallback(() => {
    revenue.reload();
    shift.reload();
    refreshFloor();
  }, [revenue, shift, refreshFloor]);

  return (
    <div className="a-dash">
      {/* ══ 1. GREETING + REAL ACTIONS ══ */}
      <section className="a-hero">
        <div>
          <h1 className="a-greeting">
            {greeting(new Date().getHours())}
            {me !== null && `, ${me.firstName}`}
          </h1>
          <p className="a-date">
            {new Intl.DateTimeFormat('en-US', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              timeZone: 'Asia/Manila',
            }).format(new Date())}
          </p>
        </div>

        <div className="a-actions">
          {canCheckIn && (
          <button type="button" className="a-btn" onClick={() => setAction('checkin')}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6L9 17l-5-5" />
            </svg>
            Manual check-in
          </button>
          )}
          {canSellWalkIn && (
            <button type="button" className="a-btn" onClick={() => setAction('walkin')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="9" cy="8" r="3.5" />
                <path d="M2.5 20a6.5 6.5 0 0113 0M17 11h5M19.5 8.5v5" />
              </svg>
              Sell walk-in
            </button>
          )}
          {canManageShift && (
            <button type="button" className="a-btn" onClick={() => setAction('shift')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
              {shift.data === null ? 'Open shift' : 'Close shift'}
            </button>
          )}
          {canShowQr && (
            <a
              href={STAFF_QR_PATH}
              target="_blank"
              rel="noopener noreferrer"
              className="a-btn"
              style={{ textDecoration: 'none' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <path d="M14 14h3v3M21 14v7h-7" />
              </svg>
              Show check-in QR
            </a>
          )}
        </div>
      </section>

      {/* ══ 2. KPI ROW — no icons ══ */}
      <section className="a-kpis">
        <div className="a-kpi">
          <span className="a-kpi-live">
            <i aria-hidden />
            Live
          </span>
          <div className="a-kpi-value">{counters?.inGym ?? '—'}</div>
          <div className="a-kpi-label">In the gym now</div>
          {counters !== undefined && (
            <div className="a-kpi-hint">of {counters.today} who came in today</div>
          )}
        </div>

        <div className="a-kpi">
          <div className="a-kpi-value">{counters?.today ?? '—'}</div>
          <div className="a-kpi-label">Check-ins today</div>
          {delta !== null && (
            <div className="a-kpi-hint">
              <span className="a-kpi-delta" data-tone={delta.tone ?? undefined}>
                {delta.text}
              </span>{' '}
              vs last {delta.weekday}
              {counters !== undefined && counters.manualToday > 0 &&
                ` · ${counters.manualToday} by staff`}
            </div>
          )}
        </div>

        <div className="a-kpi">
          <div className="a-kpi-value">{members.data?.total ?? '—'}</div>
          <div className="a-kpi-label">Active members</div>
          <div className="a-kpi-hint">With a live plan</div>
        </div>

        {canReadPayments && (
          <div className="a-kpi">
            <div className="a-kpi-value">
              {revenue.data === null ? '—' : peso(revenue.data.totalCentavos)}
            </div>
            <div className="a-kpi-label">Taken today</div>
            {shift.data !== null && (
              <div className="a-kpi-hint">Drawer open since {gymTime(shift.data.openedAt)}</div>
            )}
          </div>
        )}
      </section>

      {/* ══ 3. NEEDS YOU ══ */}
      <section className="a-attention">
        <div className="a-attention-head">
          <h2 className="a-attention-title">Needs you</h2>
          {attention.length > 0 && <span className="a-attention-count">{attention.length}</span>}
        </div>

        {attention.length === 0 ? (
          // Keeps its slot when empty. A band that vanishes makes the page jump
          // on every poll, and its absence reads the same as not-yet-loaded.
          <p className="a-attention-clear">Nothing needs you right now.</p>
        ) : (
          <div className="a-attention-row">
            {attention.map((item) => (
              <Link key={item.key} href={item.href} className="a-attention-item">
                <span className="a-attention-pip" data-tone={item.tone} aria-hidden />
                <span>
                  <span className="a-attention-item-title">{item.title}</span>
                  <span className="a-attention-item-sub">{item.sub}</span>
                </span>
                <span className="a-attention-go">{item.verb} →</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* ══ 4. MAIN GRID ══ */}
      <div className="a-grid">
        <div className="a-col">
          <section className="a-card">
            <header className="a-card-head">
              <div>
                <h2 className="a-card-title">Check-ins</h2>
                <p className="a-card-sub">Last {range} days</p>
              </div>
              <div className="a-seg" role="group" aria-label="Chart range">
                {RANGES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="a-seg-btn"
                    data-on={range === option || undefined}
                    aria-pressed={range === option}
                    onClick={() => setRange(option)}
                  >
                    {option}d
                  </button>
                ))}
              </div>
            </header>
            <DataState
              loading={chart.loading}
              error={chart.error}
              empty={false}
              emptyTitle="No check-ins in this range"
              onRetry={chart.reload}
            >
              {chartShown !== null && <CheckInsChart data={chartShown} />}
            </DataState>
          </section>

          <section className="a-card">
            <header className="a-card-head">
              <div>
                <h2 className="a-card-title">Currently in the gym</h2>
                <p className="a-card-sub">Refreshes every {FLOOR_POLL_MS / 1000} seconds</p>
              </div>
              <Link href="/admin/attendance" className="p-btn p-btn-ghost p-btn-sm">
                Live view
              </Link>
            </header>
            <DataState
              loading={inGym.loading}
              error={inGym.error}
              empty={(inGym.data?.items.length ?? 0) === 0}
              emptyTitle="No one in the gym right now"
              emptyHint="Members appear here the moment they check in."
              onRetry={inGym.reload}
            >
              <div className="a-scroll">
                <table className="p-table">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Checked in</th>
                      <th className="p-num">Duration</th>
                      <th>Standing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(inGym.data?.items ?? []).slice(0, 5).map((row) => (
                      <tr key={row.checkInId}>
                        <td>
                          <Person
                            firstName={row.member.firstName}
                            lastName={row.member.lastName}
                            sub={row.member.memberCode}
                            avatarUrl={row.member.avatarUrl}
                          />
                        </td>
                        <td className="p-muted">{gymTime(row.occurredAt)}</td>
                        <td
                          className="p-num"
                          data-tone={
                            row.durationMinutes > LONG_SESSION_MINUTES ? 'warn' : undefined
                          }
                        >
                          {duration(row.durationMinutes)}
                        </td>
                        <td>
                          {/* `verdict` is the snapshot taken AT ADMISSION, and
                              CheckIn only ever stores admissions — so the two
                              AccessVerdict values map onto ALLOW and GRACE and
                              DENY is unreachable here by construction. */}
                          <StandingBadge
                            decision={row.verdict === 'ALLOWED_IN_GRACE' ? 'GRACE' : 'ALLOW'}
                            daysRemaining={row.member.daysRemaining}
                            hasMembership={row.member.status !== null}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(inGym.data?.total ?? 0) > 5 && (
                <div className="a-card-foot">
                  <Link href="/admin/attendance" className="p-btn p-btn-ghost p-btn-sm">
                    See all {inGym.data?.total}
                  </Link>
                </div>
              )}
            </DataState>
          </section>

          {/* The noticeboard — the same one members read, fed by the shell's
              feed (the topbar bell shares it). The desk reads notices here
              and through the bell rather than on the Announcements tab, and
              a bell row lands here via ?notice=. The Suspense is load-bearing:
              the section reads ?notice= with useSearchParams. */}
          <Can permission={PERMISSIONS.ANNOUNCEMENT_READ}>
            <Suspense fallback={null}>
              <LinkedAnnouncementsSection />
            </Suspense>
          </Can>
        </div>

        {/* ══ RIGHT RAIL ══ */}
        <div className="a-col">
          <section className="a-card">
            <DataState
              loading={renewals.loading}
              error={renewals.error}
              empty={false}
              emptyTitle="No renewals in the next 90 days"
              onRetry={renewals.reload}
            >
              <RenewalsCalendar
                items={renewals.data?.items ?? []}
                today={today}
                selected={selectedDay}
                onSelect={setSelectedDay}
                truncated={(renewals.data?.total ?? 0) > PAGE * 2}
              />
            </DataState>
          </section>

          <section className="a-card">
            <header className="a-card-head">
              <div>
                <h2 className="a-card-title">
                  {selectedDay === null ? 'Expiring this week' : `Ending ${civilDate(selectedDay)}`}
                </h2>
                {selectedDay !== null && (
                  <button type="button" className="a-link-btn" onClick={() => setSelectedDay(null)}>
                    Show this week
                  </button>
                )}
              </div>
              <Link
                href="/admin/members?standing=EXPIRING&sort=ending"
                className="p-btn p-btn-ghost p-btn-sm"
              >
                All
              </Link>
            </header>
            <DataState
              loading={expiring.loading}
              error={expiring.error}
              empty={expiringRows.length === 0}
              emptyTitle={
                selectedDay === null
                  ? 'Nothing expiring in the next seven days'
                  : 'Nothing ends on that day'
              }
              emptyHint={
                selectedDay === null
                  ? 'This list is the renewal call sheet — empty is good.'
                  : undefined
              }
              onRetry={expiring.reload}
            >
              <div className="a-scroll">
                <table className="p-table">
                  <tbody>
                    {expiringRows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <Person
                            firstName={row.firstName}
                            lastName={row.lastName}
                            sub={`${row.planName} · ${civilDate(row.endsOn)}`}
                          />
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <StandingBadge
                            decision={row.decision}
                            daysRemaining={row.daysRemaining}
                            hasMembership
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </DataState>
          </section>

          {canReadPayments && (
            <section className="a-card">
              <header className="a-card-head">
                <div>
                  <h2 className="a-card-title">Recent payments</h2>
                  <p className="a-card-sub">Today</p>
                </div>
                <Link href="/admin/payments" className="p-btn p-btn-ghost p-btn-sm">
                  All
                </Link>
              </header>
              <DataState
                loading={revenue.loading}
                error={revenue.error}
                empty={(revenue.data?.items.length ?? 0) === 0}
                emptyTitle="Nothing taken yet today"
                onRetry={revenue.reload}
              >
                <ul className="a-pay-list">
                  {(revenue.data?.items ?? []).map((row) => (
                    <li key={row.id} className="a-pay-row">
                      <div>
                        {/* The presenter never sent a member name here — that
                            field was fictitious. `planName` is real and reads
                            fine in a "what was this for" list. */}
                        <div className="a-pay-name">{row.planName}</div>
                        <div className="a-pay-meta">
                          {row.method} · {gymTime(row.receivedAt)}
                        </div>
                      </div>
                      <span className="a-pay-amount">{peso(row.netCentavos)}</span>
                    </li>
                  ))}
                </ul>
              </DataState>
            </section>
          )}
        </div>
      </div>

      <ManualCheckInModal
        open={action === 'checkin'}
        onClose={() => setAction(null)}
        onRecorded={refreshFloor}
      />
      <WalkInModal open={action === 'walkin'} onClose={() => setAction(null)} onSold={refreshTill} />
      <ShiftModal
        open={action === 'shift'}
        onClose={() => setAction(null)}
        onChanged={refreshTill}
        shift={shift.data}
      />
    </div>
  );
}
