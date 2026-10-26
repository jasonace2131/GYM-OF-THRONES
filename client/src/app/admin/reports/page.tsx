'use client';

import { Suspense, useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Badge, Card, CardHead, Skeleton } from '@/components/portal/ui';
import { DataState, Kpi, Person } from '@/components/admin/ui';
import { DateRangeModal } from '@/components/admin/range/DateRangeModal';
import { useMe } from '@/components/rbac/MeProvider';
import {
  adminApi,
  duration,
  gymDateTime,
  gymTime,
  peso,
  type MembershipActivityType,
  type RevenueGroup,
} from '@/lib/adminApi';
import { GYM_TIMEZONE, formatCivilDate, gymToday } from '@/lib/gymTime';
import { fetchAllPages } from '@/lib/reportExport';
import {
  rangeFileStem,
  rangeForPreset,
  rangeLabel,
  type DateRange,
  type Preset,
} from '@/lib/reportRange';
import {
  reportTabHref,
  resolveReportTab,
  visibleReportTabs,
  type ReportTab,
} from '@/lib/reports/tabs';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { downloadCsv, downloadReportPdf, type PdfTable } from '@/lib/reportPdf';

/**
 * Reports — Figure 21 of the proposal, and the answer to REQ022.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SYSTEM COULD PRODUCE NONE OF THIS BEFORE.
 *
 * Five report endpoints existed server-side and not one had a client wrapper
 * or a button; the only file export in the whole CRM was a statutory-discount
 * CSV nothing called. An owner asking "how did January go" had to read the
 * payments list a page at a time.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Four tabs, because they answer different people's questions: attendance
 * (who came), membership activity (who joined, renewed and left), walk-ins
 * (what the front door earned, and how much of it came back) and revenue
 * (how the money moved, and what recurs).
 *
 * ── REVENUE IS A TAB NOW, NOT A SCREEN ──
 * Owner decision (2026-09-25): the front desk loses Revenue and keeps Reports
 * exactly as it was, peso figures included. Revenue is behind `revenue.read`
 * (ADMIN only) — the key `/reports/revenue` and `/reports/recurring` check —
 * and shares this screen's date range instead of its own private `daysAgo`.
 * `/admin/revenue` redirects to `?tab=revenue` (next.config.ts).
 *
 * ── EVERY DATE DECISION IS IN `@/lib/reportRange`, NOT HERE ──
 * This file used to carry its own `TZ = 'Asia/Manila'` (a fourth copy of a
 * constant that already existed), a `DAY_MS`, and a `shiftDays` helper whose
 * `shiftDays(7)` against an inclusive `to` produced an EIGHT-day window
 * labelled "Last 7 days" — so every average on this screen was out by 7/8.
 * Date arithmetic inside a component is date arithmetic no test can reach;
 * `client/vitest.config.ts` renders no React, by design. It all lives in
 * `lib/` now, with `reportRange.test.ts` beside it. Which tab opens is
 * `lib/reports/tabs.ts`, tested the same way.
 *
 * ── EVERY QUERY KEY CARRIES BOTH BOUNDS ──
 * The membership panel's key was the constant string `'report-memberships'`,
 * so it fetched once and then never refetched however the range changed: the
 * table sat there looking current while the two panels beside it moved.
 *
 * Money is integer centavos on the wire and rendered here — the server never
 * sends a formatted peso string.
 */

const ROW_LIMIT = 100;

/** Export pages at 100 rows; 50 pages is 5,000 attendance rows. */
const EXPORT_PAGE = 100;

const PRESETS: readonly [Exclude<Preset, 'custom'>, string][] = [
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['month', 'This month'],
  // The two windows the Revenue screen offered; now shared by every tab.
  ['90d', 'Last 90 days'],
  ['12m', 'Last 12 months'],
];

const EVENT_LABEL: Record<MembershipActivityType, string> = {
  PURCHASED: 'Purchased',
  RENEWED: 'Renewed',
  REACTIVATED: 'Reactivated',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

const EVENT_TONE: Record<MembershipActivityType, 'ok' | 'warn' | 'danger'> = {
  PURCHASED: 'ok',
  RENEWED: 'ok',
  REACTIVATED: 'ok',
  CANCELLED: 'danger',
  EXPIRED: 'warn',
};

const GROUPS: { key: RevenueGroup; label: string }[] = [
  { key: 'month', label: 'By month' },
  { key: 'plan', label: 'By plan' },
  { key: 'method', label: 'By method' },
  { key: 'purpose', label: 'By purpose' },
];

/**
 * `/admin/reports`.
 *
 * The `<Suspense>` is load-bearing: the tab is read from `?tab=` with
 * `useSearchParams`, and in a prerendered route that hook must sit under a
 * Suspense boundary or `next build` fails.
 */
export default function AdminReportsPage() {
  return (
    <Suspense
      fallback={
        <div style={{ display: 'grid', gap: 18 }}>
          <Skeleton height={120} />
          <Skeleton height={260} />
        </div>
      }
    >
      <Reports />
    </Suspense>
  );
}

function Reports() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { me } = useMe();
  const tabs = visibleReportTabs(me?.permissions ?? null);
  const tab = resolveReportTab(searchParams.get('tab'), tabs);
  const canRevenue = tabs.some((entry) => entry.key === 'revenue');

  const today = gymToday(new Date(), GYM_TIMEZONE);
  const [preset, setPreset] = useState<Preset>('30d');
  const [custom, setCustom] = useState<DateRange | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<RevenueGroup>('month');

  // One window, derived once, shared by every tab. `to` is no longer pinned
  // to today: a custom range that ends last Friday must not silently extend
  // to this morning.
  const range = useMemo<DateRange>(
    () => custom ?? rangeForPreset(preset === 'custom' ? '30d' : preset, today),
    [custom, preset, today],
  );
  const { from, to } = range;
  const label = rangeLabel(range);

  const attendance = useAdminQuery(
    useCallback(
      () => adminApi.checkIns({ from, to, limit: ROW_LIMIT, includeVoided: false }),
      [from, to],
    ),
    `report-attendance:${from}:${to}`,
  );

  const memberships = useAdminQuery(
    useCallback(() => adminApi.reportMemberships(from, to), [from, to]),
    `report-memberships:${from}:${to}`,
  );

  const walkIns = useAdminQuery(
    useCallback(() => adminApi.walkInStats(from, to), [from, to]),
    `report-walkins:${from}:${to}`,
  );

  // Never fetched without `revenue.read`: the routes would 403, and a panel
  // the caller cannot see has no business costing a request.
  const revenue = useAdminQuery(
    useCallback(() => adminApi.revenue(from, to, groupBy), [from, to, groupBy]),
    `report-revenue:${from}:${to}:${groupBy}`,
    { enabled: canRevenue },
  );

  const recurring = useAdminQuery(
    useCallback(() => adminApi.recurring(), []),
    'report-recurring',
    { enabled: canRevenue },
  );

  const openTab = (next: ReportTab): void => {
    router.replace(reportTabHref(next), { scroll: false });
  };

  /**
   * Every footnote names the window, and says so when the table is partial.
   *
   * A table detached from its range — pasted into an email, printed, read
   * three weeks later — is a set of numbers with no way to tell what they
   * describe. That is worse than no table, because it still looks like an
   * answer. Same for truncation: a PDF that shows the first hundred of nine
   * hundred visits and does not say so is a document that lies quietly.
   */
  const footnote = (summary: string, shown: number, total: number): string => {
    const partial = shown < total ? ` Showing the first ${shown} of ${total} rows.` : '';
    return `${summary} ${label}.${partial}`;
  };

  /** The tables, formatted once and shared by the screen and the exports. */
  const attendanceTable: PdfTable = {
    title: 'Attendance report',
    columns: ['Member', 'Date', 'In', 'Out', 'For'],
    rows: (attendance.data?.items ?? []).map((row) => [
      `${row.member.firstName} ${row.member.lastName}`.trim(),
      row.occurredAt.slice(0, 10),
      gymTime(row.occurredAt),
      row.endedAt === null ? 'still in' : gymTime(row.endedAt),
      row.durationMinutes === null ? '—' : duration(row.durationMinutes),
    ]),
    footnote: footnote(
      `${attendance.data?.total ?? 0} visits in`,
      attendance.data?.items.length ?? 0,
      attendance.data?.total ?? 0,
    ),
  };

  const membershipTable: PdfTable = {
    title: 'Membership activity',
    columns: ['Member', 'Event', 'Plan', 'Date', 'Term now ends', 'Amount'],
    rows: (memberships.data?.items ?? []).map((row) => [
      row.memberName,
      EVENT_LABEL[row.type],
      row.planName,
      formatCivilDate(row.businessDate),
      row.newEndsOn === null ? '—' : formatCivilDate(row.newEndsOn),
      row.netCentavos === null ? '—' : peso(row.netCentavos, { decimals: true }),
    ]),
    footnote:
      memberships.data == null
        ? footnote('Membership activity in', 0, 0)
        : `${memberships.data.total} membership events · ${peso(
            memberships.data.revenueCentavos,
            { decimals: true },
          )} in ${label}.${
            memberships.data.truncated
              ? ' Truncated — this window holds more events than one report returns.'
              : ''
          }`,
  };

  const walkInTable: PdfTable = {
    title: 'Walk-in breakdown by day',
    columns: ['Day', 'Count', 'Revenue', 'Peak hour'],
    rows: (walkIns.data?.byDay ?? []).map((row) => [
      row.weekday,
      String(row.count),
      peso(row.revenueCentavos, { decimals: true }),
      row.peakHour ?? '—',
    ]),
    footnote:
      walkIns.data == null
        ? footnote('No walk-in data for', 0, 0)
        : `${walkIns.data.totalWalkIns} walk-ins · ${peso(walkIns.data.revenueCentavos, {
            decimals: true,
          })} · ${walkIns.data.converted} converted to members, in ${label}.`,
  };

  const groupLabel = GROUPS.find((group) => group.key === groupBy)?.label.toLowerCase() ?? '';
  const revenueTable: PdfTable = {
    title: `Revenue ${groupLabel}`,
    columns: [groupBy === 'month' ? 'Month' : 'Group', 'Sales', 'Discounts', 'Net'],
    rows: (revenue.data?.series ?? []).map((row) => [
      row.label,
      String(row.count),
      row.discountCentavos === 0 ? '—' : peso(row.discountCentavos, { decimals: true }),
      peso(row.centavos, { decimals: true }),
    ]),
    footnote:
      revenue.data == null
        ? footnote('No revenue data for', 0, 0)
        : `${revenue.data.totalCount} sales · ${peso(revenue.data.totalCentavos, {
            decimals: true,
          })} net in ${label}. Voided and refunded payments are excluded.`,
  };

  const exportPdf = (): void => {
    void downloadReportPdf({
      title: 'Gym of Thrones — Operations report',
      subtitle: label,
      // Revenue only for a caller who can see it; the desk's PDF is exactly
      // the three tables it always was.
      tables: [
        attendanceTable,
        membershipTable,
        walkInTable,
        ...(canRevenue ? [revenueTable] : []),
      ],
      fileName: `got-report-${rangeFileStem(range)}`,
    });
  };

  /**
   * The attendance rows as a CSV — the long table, and the one a bookkeeper
   * actually sorts.
   *
   * It walks the endpoint to the end rather than exporting the hundred rows
   * on screen. A CSV named for a month that silently holds its first hundred
   * visits is the failure mode: nothing about the file says it is partial, so
   * the discrepancy surfaces as a reconciliation error weeks later. If any
   * page fails the whole export fails and nothing downloads.
   */
  const exportCsv = async (): Promise<void> => {
    setExporting(true);
    setExportError(null);
    try {
      const all = await fetchAllPages((page) =>
        adminApi.checkIns({ from, to, page, limit: EXPORT_PAGE, includeVoided: false }),
      );

      const rows = all.items.map((row) => [
        `${row.member.firstName} ${row.member.lastName}`.trim(),
        row.occurredAt.slice(0, 10),
        gymTime(row.occurredAt),
        row.endedAt === null ? 'still in' : gymTime(row.endedAt),
        row.durationMinutes === null ? '—' : duration(row.durationMinutes),
      ]);

      if (all.truncated) {
        rows.push([`Truncated at ${all.items.length} rows of ${all.total}.`, '', '', '', '']);
      }

      downloadCsv(`got-attendance-${rangeFileStem(range)}`, attendanceTable.columns, rows);
    } catch {
      setExportError('The export could not be completed. Nothing was downloaded — try again.');
    } finally {
      setExporting(false);
    }
  };

  /** Arrow keys move between tabs, as the WAI-ARIA tabs pattern expects. */
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = tabs.findIndex((entry) => entry.key === tab);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next === undefined) return;
    openTab(next.key);
    document.getElementById(`report-tab-${next.key}`)?.focus();
  };

  const counts = memberships.data?.counts;
  const max = Math.max(1, ...(revenue.data?.series ?? []).map((row) => row.centavos));

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <Card>
        <CardHead
          title="Reports"
          action={
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                onClick={() => void exportCsv()}
                disabled={exporting}
              >
                {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
              <button
                type="button"
                className="p-btn p-btn-gold p-btn-sm"
                onClick={exportPdf}
                disabled={exporting}
              >
                Export PDF
              </button>
            </div>
          }
        />
        <div className="a-toolbar" style={{ paddingTop: 12, flexWrap: 'wrap' }}>
          {PRESETS.map(([value, text]) => (
            <button
              key={value}
              type="button"
              className={`p-btn p-btn-sm ${
                preset === value && custom === null ? 'p-btn-gold' : 'p-btn-ghost'
              }`}
              aria-pressed={preset === value && custom === null}
              onClick={() => {
                setPreset(value);
                setCustom(null);
              }}
            >
              {text}
            </button>
          ))}
          <button
            type="button"
            className={`p-btn p-btn-sm ${custom === null ? 'p-btn-ghost' : 'p-btn-gold'}`}
            aria-pressed={custom !== null}
            onClick={() => setPickerOpen(true)}
          >
            Custom…
          </button>
          <span className="p-muted" style={{ fontSize: 12.5, marginLeft: 'auto' }}>
            {label}
          </span>
        </div>
        {exportError === null ? null : (
          <div className="a-modal-err" role="alert" style={{ marginTop: 12 }}>
            {exportError}
          </div>
        )}
      </Card>

      <DateRangeModal
        open={pickerOpen}
        initial={range}
        today={today}
        onClose={() => setPickerOpen(false)}
        onApply={(next) => {
          setCustom(next);
          setPreset('custom');
          setPickerOpen(false);
        }}
      />

      {/* One panel at a time, one date range for all of them. */}
      <div className="a-tabs" role="tablist" aria-label="Report">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            id={`report-tab-${entry.key}`}
            type="button"
            role="tab"
            className="a-tab"
            aria-selected={tab === entry.key}
            aria-controls="report-panel"
            tabIndex={tab === entry.key ? 0 : -1}
            onClick={() => openTab(entry.key)}
            onKeyDown={onTabKey}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        id="report-panel"
        role="tabpanel"
        aria-labelledby={`report-tab-${tab}`}
        style={{ display: 'grid', gap: 18 }}
      >
        {tab === 'walk-ins' ? (
          <>
            {/* ── Walk-in statistics ── */}
            <div className="a-kpis">
              <Kpi value={walkIns.data?.totalWalkIns ?? '—'} label="Total walk-ins" />
              <Kpi
                value={walkIns.data == null ? '—' : peso(walkIns.data.revenueCentavos)}
                label="Revenue generated"
              />
              {/* `<0.1`, not `0`, when there WERE walk-ins.
                  The server rounds to one decimal, so one walk-in across a
                  31-day range is a true 0.03 that renders as a flat "0" —
                  sitting directly beside a tile reading "1 total walk-ins".
                  Two numbers that appear to contradict each other is how staff
                  stop trusting the whole screen, and the fix is to say the
                  small number is small rather than to round it away. */}
              <Kpi
                value={
                  walkIns.data == null
                    ? '—'
                    : walkIns.data.averagePerDay === 0 && walkIns.data.totalWalkIns > 0
                      ? '<0.1'
                      : walkIns.data.averagePerDay
                }
                label="Average per day"
              />
              <Kpi
                value={walkIns.data?.converted ?? '—'}
                label="Converted to members"
                delta="from walk-in visits"
              />
            </div>

            <Card padded={false}>
              <div style={{ padding: '18px 18px 0' }}>
                <CardHead title="Walk-in breakdown by day" />
              </div>
              <DataState
                loading={walkIns.loading}
                error={walkIns.error}
                empty={(walkIns.data?.byDay.length ?? 0) === 0}
                emptyTitle="No walk-ins in this range"
                emptyHint="Day passes sold at the counter appear here."
                onRetry={walkIns.reload}
              >
                <div className="a-scroll">
                  <table className="p-table" data-stack>
                    <thead>
                      <tr>
                        <th>Day</th>
                        <th className="p-num">Count</th>
                        <th className="p-num">Revenue</th>
                        <th>Peak hour</th>
                      </tr>
                    </thead>
                    <tbody>
                      {walkIns.data?.byDay.map((row) => (
                        <tr key={row.weekday}>
                          <td data-card="title">{row.weekday}</td>
                          <td className="p-num" data-label="Count">
                            {row.count}
                          </td>
                          <td className="p-num" data-card="value">
                            {peso(row.revenueCentavos, { decimals: true })}
                          </td>
                          <td className="p-muted" data-label="Peak hour">
                            {row.peakHour ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </DataState>
            </Card>
          </>
        ) : null}

        {tab === 'attendance' ? (
          /* ── Attendance ── */
          <Card padded={false}>
            <div style={{ padding: '18px 18px 0' }}>
              <CardHead
                title="Attendance report"
                action={
                  <span className="p-muted" style={{ fontSize: 12.5 }}>
                    {attendance.data?.total ?? 0} visits
                    {(attendance.data?.total ?? 0) > ROW_LIMIT
                      ? ` · showing first ${ROW_LIMIT}`
                      : ''}
                  </span>
                }
              />
            </div>
            <DataState
              loading={attendance.loading}
              error={attendance.error}
              empty={(attendance.data?.items.length ?? 0) === 0}
              emptyTitle="No visits in this range"
              emptyHint="Check-ins recorded at the station or the desk appear here."
              onRetry={attendance.reload}
            >
              <div className="a-scroll">
                <table className="p-table" data-stack>
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Date</th>
                      <th>In</th>
                      <th>Out</th>
                      <th className="p-num">For</th>
                      <th>Entry</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attendance.data?.items.map((row) => (
                      <tr key={row.checkInId}>
                        <td data-card="title">
                          <Person
                            firstName={row.member.firstName}
                            lastName={row.member.lastName}
                            sub={row.member.memberCode ?? '—'}
                            avatarUrl={row.member.avatarUrl}
                          />
                        </td>
                        <td className="p-muted" data-label="Date" data-card="meta">
                          {gymDateTime(row.occurredAt).split(',')[0]}
                        </td>
                        <td data-label="In">{gymTime(row.occurredAt)}</td>
                        <td className="p-muted" data-label="Out">
                          {row.endedAt === null ? 'still in' : gymTime(row.endedAt)}
                        </td>
                        <td className="p-num" data-label="For">
                          {row.durationMinutes === null ? '—' : duration(row.durationMinutes)}
                        </td>
                        <td data-label="Entry" data-card="meta">
                          <Badge tone="neutral">
                            {row.entryType === 'MEMBERSHIP'
                              ? 'member'
                              : row.entryType === 'GUEST_PASS'
                                ? 'guest pass'
                                : 'walk-in'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </DataState>
          </Card>
        ) : null}

        {tab === 'memberships' ? (
          /* ── Membership activity ──
              Sourced from the append-only MembershipEvent log, not from a
              filter over Membership: `userId` is @unique there, one row per
              member with renewals mutating it, so `startsOn`/`endsOn` describe
              only the CURRENT term and a date filter over them answers a
              historical question with today's answer. */
          <Card padded={false}>
            <div style={{ padding: '18px 18px 0' }}>
              <CardHead
                title="Membership activity"
                action={
                  <span className="p-muted" style={{ fontSize: 12.5 }}>
                    {memberships.data?.total ?? 0} events
                    {memberships.data?.truncated === true ? ' · truncated' : ''}
                  </span>
                }
              />
            </div>
            <DataState
              loading={memberships.loading}
              error={memberships.error}
              empty={(memberships.data?.items.length ?? 0) === 0}
              emptyTitle="No membership activity in this range."
              emptyHint="Purchases, renewals, reactivations, cancellations and expiries appear here."
              onRetry={memberships.reload}
            >
              <div className="a-scroll">
                <table className="p-table" data-stack>
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Event</th>
                      <th>Plan</th>
                      <th>Date</th>
                      <th>Term now ends</th>
                      <th className="p-num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memberships.data?.items.map((row) => (
                      <tr key={row.eventId}>
                        <td data-card="title">
                          <Person
                            firstName={row.memberName.split(' ')[0] ?? row.memberName}
                            lastName={row.memberName.split(' ').slice(1).join(' ')}
                            sub={row.memberCode ?? '—'}
                            avatarUrl={null}
                          />
                        </td>
                        <td data-label="Event" data-card="meta">
                          <Badge tone={EVENT_TONE[row.type]}>{EVENT_LABEL[row.type]}</Badge>
                        </td>
                        {/* The plan AS SOLD, from the joined Payment — not the
                            member's plan today. */}
                        <td data-label="Plan">{row.planName}</td>
                        <td className="p-muted" data-label="Date" data-card="meta">
                          {formatCivilDate(row.businessDate)}
                        </td>
                        <td className="p-muted" data-label="Term now ends">
                          {row.newEndsOn === null ? '—' : formatCivilDate(row.newEndsOn)}
                        </td>
                        <td className="p-num" data-card="value">
                          {row.netCentavos === null
                            ? '—'
                            : peso(row.netCentavos, { decimals: true })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </DataState>

            {/* The counts and the money, under the table rather than as KPI
                tiles: they describe THIS table's window, and a tile row
                floating above a different panel is how a figure gets read
                against the wrong range. */}
            {counts === undefined || memberships.data == null ? null : (
              <p
                className="p-muted"
                style={{ padding: '12px 18px 18px', fontSize: 12.5, lineHeight: 1.6, margin: 0 }}
              >
                {counts.PURCHASED} purchased · {counts.RENEWED} renewed · {counts.REACTIVATED}{' '}
                reactivated · {counts.CANCELLED} cancelled · {counts.EXPIRED} expired ·{' '}
                <strong style={{ color: 'var(--p-ink)' }}>
                  {peso(memberships.data.revenueCentavos, { decimals: true })}
                </strong>{' '}
                recorded in {label}.
                {memberships.data.truncated
                  ? ' This window holds more events than one report returns — narrow it for a complete count.'
                  : ''}
              </p>
            )}
          </Card>
        ) : null}

        {tab === 'revenue' && canRevenue ? (
          <>
            {/* ── Recurring: the numbers an owner asks for by name ──
                No range: these describe right now, whatever window is set. */}
            <section className="a-kpis">
              <div className="a-kpi">
                <div className="a-kpi-value">
                  {recurring.data === null ? '—' : peso(recurring.data.mrrCentavos)}
                </div>
                <div className="a-kpi-label">Monthly recurring</div>
                {/* Said out loud, because summing an annual plan into the
                    month it sold would be a much larger and much more
                    flattering number. */}
                <div className="a-kpi-hint">Each live plan, normalised per month</div>
              </div>

              <div className="a-kpi">
                <div className="a-kpi-value">{recurring.data?.activeMembers ?? '—'}</div>
                <div className="a-kpi-label">Paying members</div>
              </div>

              <div className="a-kpi">
                <div className="a-kpi-value">
                  {recurring.data === null ? '—' : peso(recurring.data.arpuCentavos)}
                </div>
                <div className="a-kpi-label">Average per member</div>
              </div>

              <div className="a-kpi">
                <div className="a-kpi-value">
                  {recurring.data == null || recurring.data.churnRate === null
                    ? '—'
                    : `${Math.round(recurring.data.churnRate * 100)}%`}
                </div>
                <div className="a-kpi-label">Churn, last 30 days</div>
                <div className="a-kpi-hint">
                  {recurring.data === null
                    ? ''
                    : recurring.data.churnRate === null
                      ? 'No terms came up'
                      : `${recurring.data.lapsedLast30} lapsed · ${recurring.data.renewedLast30} renewed`}
                </div>
              </div>
            </section>

            <Card padded={false}>
              <div style={{ padding: '18px 18px 0' }}>
                <CardHead
                  title="Revenue"
                  action={
                    <span className="p-muted" style={{ fontSize: 12.5 }}>
                      {label}
                    </span>
                  }
                />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '12px 0 4px' }}>
                  {GROUPS.map((group) => (
                    <button
                      key={group.key}
                      type="button"
                      className={`p-btn p-btn-sm ${groupBy === group.key ? 'p-btn-gold' : 'p-btn-ghost'}`}
                      aria-pressed={groupBy === group.key}
                      onClick={() => setGroupBy(group.key)}
                    >
                      {group.label}
                    </button>
                  ))}
                </div>
              </div>

              <DataState
                loading={revenue.loading}
                error={revenue.error}
                empty={(revenue.data?.series.length ?? 0) === 0}
                emptyTitle="No payments in this range"
                emptyHint="Widen the range, or record a sale at the desk."
                onRetry={revenue.reload}
              >
                <div className="a-scroll">
                  <table className="p-table" data-stack>
                    <thead>
                      <tr>
                        <th>{groupBy === 'month' ? 'Month' : 'Group'}</th>
                        <th />
                        <th className="p-num">Sales</th>
                        <th className="p-num">Discounts</th>
                        <th className="p-num">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(revenue.data?.series ?? []).map((row) => (
                        <tr key={row.key}>
                          <td data-card="title">{row.label}</td>
                          {/* A bar in the row rather than a chart above it:
                              the comparison people actually make is between
                              adjacent rows, and this keeps the number beside
                              its own bar. */}
                          <td data-card="bar" style={{ width: '38%', minWidth: 120 }}>
                            <div
                              aria-hidden
                              style={{
                                height: 7,
                                borderRadius: 4,
                                background: 'var(--gold)',
                                opacity: 0.8,
                                width: `${Math.max(2, (row.centavos / max) * 100)}%`,
                              }}
                            />
                          </td>
                          <td className="p-num" data-label="Sales">
                            {row.count}
                          </td>
                          <td className="p-num" data-label="Discounts">
                            {row.discountCentavos === 0 ? (
                              <span className="p-muted">—</span>
                            ) : (
                              peso(row.discountCentavos)
                            )}
                          </td>
                          <td className="p-num" data-card="value">
                            <strong>{peso(row.centavos)}</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={2} data-card="title">
                          <strong>Total</strong>
                        </td>
                        <td className="p-num" data-label="Sales">
                          {revenue.data?.totalCount ?? 0}
                        </td>
                        <td className="p-num" data-label="Discounts">
                          {peso(revenue.data?.totalDiscountCentavos ?? 0)}
                        </td>
                        <td className="p-num" data-card="value">
                          <strong>{peso(revenue.data?.totalCentavos ?? 0)}</strong>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </DataState>

              <div style={{ padding: '14px 18px 18px' }}>
                <p className="p-muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: 0 }}>
                  Voided and refunded payments are <strong>excluded</strong>, not counted as zero —
                  a void did not happen, and netting it would leave the money right while making
                  the sale count wrong.
                </p>
              </div>
            </Card>
          </>
        ) : null}
      </div>
    </div>
  );
}
