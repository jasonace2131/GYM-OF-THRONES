'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { CheckInRecord } from '@got/shared';
import { Badge, Card, CardHead } from '@/components/portal/ui';
import { DataState, Kpi, Pager, Person } from '@/components/admin/ui';
import { adminApi, duration, gymTime } from '@/lib/adminApi';
import { GYM_TIMEZONE, gymToday } from '@/lib/gymTime';
import { downloadCsv } from '@/lib/reportPdf';
import { fetchAllPages } from '@/lib/reportExport';
import { useAdminQuery, useDebounced } from '@/lib/useAdminQuery';
import {
  DEFAULT_FILTERS,
  METHOD_OPTIONS,
  PERIODS,
  STATUS_OPTIONS,
  TYPE_OPTIONS,
  activeFilterCount,
  csvFileStem,
  historyProblem,
  historyQuery,
  historySearch,
  parseHistory,
  summaryQuery,
  windowOf,
  type HistoryFilters,
} from '@/lib/attendance/historyFilters';

const PAGE_SIZE = 25;
const EXPORT_PAGE = 100;

const TYPE_LABEL: Record<CheckInRecord['entryType'], string> = {
  MEMBERSHIP: 'Membership',
  WALK_IN: 'Walk-in',
  GUEST_PASS: 'Guest pass',
};
const TYPE_TONE: Record<CheckInRecord['entryType'], 'ok' | 'warn' | 'info'> = {
  MEMBERSHIP: 'ok',
  WALK_IN: 'warn',
  GUEST_PASS: 'info',
};
const METHOD_LABEL: Record<string, string> = {
  STATION_QR: 'Station scan',
  MEMBER_CODE: 'Member code',
  MANUAL: 'Staff',
};

/** "Mon 9 Nov", with the year when it is not this one — in gym time. */
function visitDay(iso: string, thisYear: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: GYM_TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const year = get('year');
  return `${get('weekday')} ${get('day')} ${get('month')}${year === thisYear ? '' : ` ${year}`}`;
}

/**
 * Attendance → History (feat/attendance-history, owner 2026-11-09).
 *
 * Every past visit, filtered by date range, member, visit type, how they got
 * in and whether they are still inside. The filters live in the address
 * (`lib/attendance/historyFilters.ts`), so this component reads them from the
 * URL and writes them back; it keeps no filter state of its own except the
 * search box while someone is typing.
 *
 * The totals come from `GET /check-ins/summary` with the SAME filters as the
 * list, so they always describe the rows under them.
 */
export function AttendanceHistory() {
  const router = useRouter();
  const params = useSearchParams();
  const filters = useMemo(() => parseHistory(new URLSearchParams(params.toString())), [params]);
  const today = gymToday(new Date(), GYM_TIMEZONE);
  const range = windowOf(filters, today);
  const problem = historyProblem(filters, today);
  const query = useMemo(() => historyQuery(filters, today), [filters, today]);

  const go = useCallback(
    (next: HistoryFilters): void => {
      router.replace(`/admin/attendance${historySearch(next)}`, { scroll: false });
    },
    [router],
  );

  // The search box types freely; the address (and the request) follow 300 ms later.
  const [search, setSearch] = useState(filters.q);
  const settled = useDebounced(search, 300);
  useEffect(() => {
    if (settled.trim() !== filters.q.trim()) go({ ...filters, q: settled, page: 1 });
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps -- only a settled keystroke navigates

  const listKey = JSON.stringify(query);
  const list = useAdminQuery(
    useCallback(
      () => adminApi.checkIns({ ...query, page: filters.page, limit: PAGE_SIZE }),
      [query, filters.page],
    ),
    `history:${listKey}:${filters.page}`,
    { enabled: problem === null },
  );
  const summary = useAdminQuery(
    useCallback(() => adminApi.checkInSummary(summaryQuery(filters, today)), [filters, today]),
    `history-summary:${listKey}`,
    { enabled: problem === null },
  );
  const member = useAdminQuery(
    useCallback(
      () => (filters.member === null ? Promise.resolve(null) : adminApi.member(filters.member)),
      [filters.member],
    ),
    `history-member:${filters.member ?? 'none'}`,
  );
  const memberName =
    filters.member === null
      ? null
      : member.data
        ? `${member.data.firstName} ${member.data.lastName}`.trim()
        : 'One member';

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportCsv = async (): Promise<void> => {
    setExporting(true);
    setExportError(null);
    try {
      const all = await fetchAllPages((page) =>
        adminApi.checkIns({ ...query, page, limit: EXPORT_PAGE }),
      );
      const rows = all.items.map((row) => [
        `${row.member.firstName} ${row.member.lastName}`.trim(),
        row.member.memberCode ?? (row.member.userId === null ? 'Walk-in guest' : ''),
        gymToday(new Date(row.occurredAt), GYM_TIMEZONE),
        gymTime(row.occurredAt),
        row.endedAt === null ? 'still in' : gymTime(row.endedAt),
        row.durationMinutes === null ? '' : duration(row.durationMinutes),
        TYPE_LABEL[row.entryType],
        METHOD_LABEL[row.method] ?? row.method,
        row.voidedAt === null ? '' : `Voided: ${row.voidReason ?? ''}`.trim(),
      ]);
      if (all.truncated) {
        rows.push([
          `Stopped at ${all.items.length} of ${all.total} visits.`,
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ]);
      }
      downloadCsv(
        csvFileStem(filters, today, memberName),
        ['Member', 'Member code', 'Date', 'In', 'Out', 'Stayed', 'Type', 'How', 'Voided'],
        rows,
      );
    } catch {
      setExportError('The download could not be completed. Nothing was saved. Try again.');
    } finally {
      setExporting(false);
    }
  };

  const thisYear = today.slice(0, 4);
  const narrowed = activeFilterCount(filters) > 0 || filters.period !== DEFAULT_FILTERS.period;
  const totals = summary.data;
  const typeTotal = totals === null ? 0 : totals.visits;

  return (
    <div className="a-history">
      <div className="a-filters" role="group" aria-label="Filter visits">
        <div className="a-filters-row">
          <span className="a-filters-label" aria-hidden>
            Period
          </span>
          <div className="a-filters-controls">
            <div className="a-range" role="radiogroup" aria-label="Date range">
              {PERIODS.map((period) => (
                <button
                  key={period.key}
                  type="button"
                  role="radio"
                  aria-checked={filters.period === period.key}
                  className="a-range-btn"
                  onClick={() =>
                    go({ ...filters, period: period.key, from: null, to: null, page: 1 })
                  }
                >
                  {period.label}
                </button>
              ))}
            </div>
            <div className="a-daterange">
              <label className="a-daterange-part">
                <span className="a-daterange-tag">From</span>
                <input
                  id="history-from"
                  type="date"
                  className="a-daterange-input"
                  value={range?.from ?? ''}
                  max={today}
                  onChange={(event) => {
                    if (event.target.value === '') return;
                    go({
                      ...filters,
                      period: 'custom',
                      from: event.target.value as HistoryFilters['from'],
                      to: range?.to ?? today,
                      page: 1,
                    });
                  }}
                />
              </label>
              <span className="a-daterange-sep" aria-hidden>
                –
              </span>
              <label className="a-daterange-part">
                <span className="a-daterange-tag">To</span>
                <input
                  id="history-to"
                  type="date"
                  className="a-daterange-input"
                  value={range?.to ?? ''}
                  max={today}
                  onChange={(event) => {
                    if (event.target.value === '') return;
                    go({
                      ...filters,
                      period: 'custom',
                      from: range?.from ?? (event.target.value as HistoryFilters['to']),
                      to: event.target.value as HistoryFilters['to'],
                      page: 1,
                    });
                  }}
                />
              </label>
            </div>
          </div>
        </div>

        <div className="a-filters-row">
          <span className="a-filters-label" aria-hidden>
            Find
          </span>
          <div className="a-filters-controls">
            <input
              id="history-search"
              className="a-input a-history-search"
              type="search"
              value={search}
              maxLength={64}
              placeholder="Name or member code"
              aria-label="Search visits by name or member code"
              onChange={(event) => setSearch(event.target.value)}
            />
            {memberName === null ? null : (
              <span className="a-history-chip">
                Only {memberName}
                <button
                  type="button"
                  aria-label={`Show everyone, not only ${memberName}`}
                  onClick={() =>
                    go({
                      ...filters,
                      member: null,
                      period: filters.period === 'all' ? '30d' : filters.period,
                      page: 1,
                    })
                  }
                >
                  ✕
                </button>
              </span>
            )}
          </div>
        </div>

        <div className="a-filters-row">
          <span className="a-filters-label" aria-hidden>
            Show
          </span>
          <div className="a-filters-controls">
            <select
              id="history-type"
              className="a-filters-select"
              aria-label="Visit type"
              value={filters.type}
              onChange={(event) =>
                go({ ...filters, type: event.target.value as HistoryFilters['type'], page: 1 })
              }
            >
              {TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              id="history-method"
              className="a-filters-select"
              aria-label="How they checked in"
              value={filters.how}
              onChange={(event) =>
                go({ ...filters, how: event.target.value as HistoryFilters['how'], page: 1 })
              }
            >
              {METHOD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              id="history-status"
              className="a-filters-select"
              aria-label="Visit status"
              value={filters.status}
              onChange={(event) =>
                go({ ...filters, status: event.target.value as HistoryFilters['status'], page: 1 })
              }
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {narrowed ? (
              <button
                type="button"
                className="a-filters-reset"
                onClick={() => {
                  setSearch('');
                  go(DEFAULT_FILTERS);
                }}
              >
                Clear filters
              </button>
            ) : null}
          </div>
        </div>

        {problem === null ? null : (
          <p className="a-field-hint" data-tone="danger" role="alert">
            {problem}
          </p>
        )}
      </div>

      <div className="a-kpis" aria-live="polite">
        <Kpi value={totals?.visits.toLocaleString('en-PH') ?? '—'} label="Visits" />
        <Kpi value={totals?.people.toLocaleString('en-PH') ?? '—'} label="People" />
        <Kpi
          value={
            totals?.averageMinutes === null || totals === null
              ? '—'
              : duration(totals.averageMinutes)
          }
          label="Average stay"
        />
        <Card>
          <div className="p-stat-label">Visit types</div>
          <div className="a-history-split" aria-hidden>
            {(['MEMBERSHIP', 'WALK_IN', 'GUEST_PASS'] as const).map((type) => (
              <i
                key={type}
                data-type={type}
                style={{
                  width: `${typeTotal === 0 ? 0 : ((totals?.byType[type] ?? 0) / typeTotal) * 100}%`,
                }}
              />
            ))}
          </div>
          <div className="a-history-legend">
            {(['MEMBERSHIP', 'WALK_IN', 'GUEST_PASS'] as const).map((type) => (
              <span key={type}>
                <i data-type={type} aria-hidden />
                {TYPE_LABEL[type]} {totals?.byType[type] ?? '—'}
              </span>
            ))}
          </div>
        </Card>
      </div>

      <Card padded={false}>
        <div className="a-history-head">
          <CardHead
            title={memberName === null ? 'Visits' : `${memberName}: visits`}
            action={
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                disabled={exporting || problem !== null || (list.data?.total ?? 0) === 0}
                onClick={() => void exportCsv()}
              >
                {exporting ? 'Preparing…' : 'Download CSV'}
              </button>
            }
          />
          {exportError === null ? null : (
            <p className="a-field-hint" data-tone="danger" role="alert">
              {exportError}
            </p>
          )}
        </div>
        {problem !== null ? (
          <p className="a-history-empty">Fix the date range above to see visits.</p>
        ) : (
          <DataState
            loading={list.loading}
            error={list.error}
            empty={(list.data?.items.length ?? 0) === 0}
            emptyTitle="No visits match these filters"
            emptyHint="Try a wider date range, or clear a filter."
            onRetry={list.reload}
          >
            <div className="a-scroll">
              <table className="p-table" data-stack>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Date</th>
                    <th>Time</th>
                    <th className="p-num a-history-stayed">Stayed</th>
                    <th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data?.items.map((row) => (
                    <tr key={row.checkInId} data-voided={row.voidedAt !== null || undefined}>
                      <td data-card="title">
                        {row.member.userId === null ? (
                          <Person
                            firstName={row.member.firstName}
                            lastName={row.member.lastName}
                            sub="Walk-in guest"
                            avatarUrl={null}
                          />
                        ) : (
                          <button
                            type="button"
                            className="a-history-person"
                            title="Show only this member's visits"
                            onClick={() => {
                              setSearch('');
                              go({ ...filters, member: row.member.userId, q: '', page: 1 });
                            }}
                          >
                            <Person
                              firstName={row.member.firstName}
                              lastName={row.member.lastName}
                              sub={row.member.memberCode ?? row.member.planName}
                              avatarUrl={row.member.avatarUrl}
                            />
                          </button>
                        )}
                      </td>
                      <td data-label="Date" data-card="meta">
                        <span className="a-history-day">{visitDay(row.occurredAt, thisYear)}</span>
                        {row.voidedAt === null ? null : (
                          <div>
                            <Badge tone="danger">Voided</Badge>
                            {row.voidReason ? (
                              <div className="a-person-sub">{row.voidReason}</div>
                            ) : null}
                          </div>
                        )}
                      </td>
                      {/* In and out share one cell, so the table fits beside the
                          sidebar on a small laptop, and reads as one phrase. */}
                      <td data-label="Time" data-card="meta">
                        <span className="a-history-time">
                          <span>{gymTime(row.occurredAt)}</span>
                          <span aria-label="to">–</span>
                          {row.endedAt === null ? (
                            <Badge tone="ok">Inside</Badge>
                          ) : row.autoClosed ? (
                            <span title="Not checked out; closed automatically at closing time">
                              <Badge tone="neutral">Auto-closed</Badge>
                            </span>
                          ) : (
                            <span>{gymTime(row.endedAt)}</span>
                          )}
                        </span>
                        {/* Stayed, under the time, only where its own column does not fit
                            (901–1100px: a small laptop or a tablet in landscape). */}
                        <span className="a-history-stay">
                          {row.durationMinutes === null || row.autoClosed
                            ? null
                            : `Stayed ${duration(row.durationMinutes)}`}
                        </span>
                      </td>
                      <td data-label="Stayed" data-card="value" className="p-num a-history-stayed">
                        {row.durationMinutes === null || row.autoClosed
                          ? '—'
                          : duration(row.durationMinutes)}
                      </td>
                      <td data-label="Type" data-card="meta">
                        <Badge tone={TYPE_TONE[row.entryType]}>{TYPE_LABEL[row.entryType]}</Badge>
                        <span className="a-history-how">
                          {METHOD_LABEL[row.method] ?? row.method}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="a-history-pager">
              <Pager
                page={filters.page}
                limit={PAGE_SIZE}
                total={list.data?.total ?? 0}
                onPage={(page) => go({ ...filters, page })}
              />
            </div>
          </DataState>
        )}
      </Card>
    </div>
  );
}
