import { REPORT_MAX_RANGE_DAYS } from '@got/shared';
import { addDays, asCivilDate, civilDaysBetween, type CivilDate } from '@/lib/gymTime';

/**
 * Attendance → History, the filters (feat/attendance-history, owner 2026-11-09).
 *
 * They live in the page address — `?view=history&period=30d&member=…` — so
 * Back works, a refresh keeps them, and a filtered view can be sent to another
 * staff member. This module is the one place that reads and writes that
 * address; the screen never touches `URLSearchParams` itself.
 *
 * The rules mirror the server's (`CheckInsReportService.assertWindow`): a
 * range may not run backwards, and over a year needs one member chosen.
 */

export type PeriodKey = 'today' | '7d' | '30d' | 'month' | 'last' | 'all' | 'custom';
export type VisitType = '' | 'MEMBERSHIP' | 'WALK_IN' | 'GUEST_PASS';
export type VisitMethod = '' | 'STATION_QR' | 'MEMBER_CODE' | 'MANUAL';
export type VisitStatus = '' | 'inside' | 'voided';

export interface HistoryFilters {
  period: PeriodKey;
  /** Set only for `custom`; the presets compute their own from today. */
  from: CivilDate | null;
  to: CivilDate | null;
  /** A member's user id: "Only Ana Reyes". */
  member: string | null;
  q: string;
  type: VisitType;
  how: VisitMethod;
  status: VisitStatus;
  page: number;
}

/** The quick picks, in the order the bar shows them. "All time" needs a member. */
export const PERIODS: ReadonlyArray<{ key: Exclude<PeriodKey, 'custom'>; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'month', label: 'This month' },
  { key: 'last', label: 'Last month' },
  { key: 'all', label: 'All time' },
];

export const TYPE_OPTIONS: ReadonlyArray<{ value: VisitType; label: string }> = [
  { value: '', label: 'All visit types' },
  { value: 'MEMBERSHIP', label: 'Membership' },
  { value: 'WALK_IN', label: 'Walk-in' },
  { value: 'GUEST_PASS', label: 'Guest pass' },
];

export const METHOD_OPTIONS: ReadonlyArray<{ value: VisitMethod; label: string }> = [
  { value: '', label: 'Any check-in method' },
  { value: 'STATION_QR', label: 'Scanned the station' },
  { value: 'MEMBER_CODE', label: 'Member code at the desk' },
  { value: 'MANUAL', label: 'Let in by staff' },
];

export const STATUS_OPTIONS: ReadonlyArray<{ value: VisitStatus; label: string }> = [
  { value: '', label: 'All visits' },
  { value: 'inside', label: 'Still inside' },
  { value: 'voided', label: 'Include voided' },
];

/** What a fresh History tab shows: the last 7 days, everyone. */
export const DEFAULT_FILTERS: HistoryFilters = {
  period: '7d',
  from: null,
  to: null,
  member: null,
  q: '',
  type: '',
  how: '',
  status: '',
  page: 1,
};

const oneOf = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

const dateOrNull = (value: string | null): CivilDate | null => {
  if (value === null) return null;
  try {
    return asCivilDate(value);
  } catch {
    return null;
  }
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The address, read leniently: anything malformed falls back to the default. */
export function parseHistory(params: URLSearchParams): HistoryFilters {
  const from = dateOrNull(params.get('from'));
  const to = dateOrNull(params.get('to'));
  const member = params.get('member');
  const period = oneOf<PeriodKey>(
    params.get('period'),
    ['today', '7d', '30d', 'month', 'last', 'all', 'custom'],
    from !== null || to !== null ? 'custom' : DEFAULT_FILTERS.period,
  );
  const page = Number.parseInt(params.get('page') ?? '1', 10);
  return {
    period: period === 'custom' && (from === null || to === null) ? DEFAULT_FILTERS.period : period,
    from: period === 'custom' ? from : null,
    to: period === 'custom' ? to : null,
    member: member !== null && UUID.test(member) ? member : null,
    q: (params.get('q') ?? '').slice(0, 64),
    type: oneOf<VisitType>(params.get('type'), ['MEMBERSHIP', 'WALK_IN', 'GUEST_PASS'], ''),
    how: oneOf<VisitMethod>(params.get('how'), ['STATION_QR', 'MEMBER_CODE', 'MANUAL'], ''),
    status: oneOf<VisitStatus>(params.get('status'), ['inside', 'voided'], ''),
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

/** The filters as an address. Defaults are left out, so a plain History link stays short. */
export function historySearch(filters: HistoryFilters): string {
  const params = new URLSearchParams({ view: 'history' });
  if (filters.period !== DEFAULT_FILTERS.period) params.set('period', filters.period);
  if (filters.period === 'custom' && filters.from !== null && filters.to !== null) {
    params.set('from', filters.from);
    params.set('to', filters.to);
  }
  if (filters.member !== null) params.set('member', filters.member);
  if (filters.q.trim() !== '') params.set('q', filters.q.trim());
  if (filters.type !== '') params.set('type', filters.type);
  if (filters.how !== '') params.set('how', filters.how);
  if (filters.status !== '') params.set('status', filters.status);
  if (filters.page > 1) params.set('page', String(filters.page));
  return `?${params.toString()}`;
}

/** The member drawer's "See all visits": one member, all time. */
export function memberHistoryHref(userId: string): string {
  return `/admin/attendance${historySearch({ ...DEFAULT_FILTERS, member: userId, period: 'all' })}`;
}

function firstOfMonth(day: CivilDate): CivilDate {
  return `${day.slice(0, 8)}01` as CivilDate;
}

/**
 * The dates a filter covers, in gym time. `null` for "All time", which sends
 * no bounds and is allowed only for one member.
 */
export function windowOf(
  filters: HistoryFilters,
  today: CivilDate,
): { from: CivilDate; to: CivilDate } | null {
  switch (filters.period) {
    case 'today':
      return { from: today, to: today };
    case '7d':
      return { from: addDays(today, -6), to: today };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case 'month':
      return { from: firstOfMonth(today), to: today };
    case 'last': {
      const end = addDays(firstOfMonth(today), -1);
      return { from: firstOfMonth(end), to: end };
    }
    case 'all':
      return null;
    case 'custom':
      return filters.from !== null && filters.to !== null
        ? { from: filters.from, to: filters.to }
        : { from: addDays(today, -6), to: today };
  }
}

/** Why these filters cannot be asked for, in the bar's words; null when they can. */
export function historyProblem(filters: HistoryFilters, today: CivilDate): string | null {
  const window = windowOf(filters, today);
  if (window === null) {
    return filters.member === null
      ? 'All time works for one member. Pick a member, or choose a range up to a year.'
      : null;
  }
  const span = civilDaysBetween(window.from, window.to);
  if (span < 0) return 'The From date is after the To date.';
  if (filters.member === null && span > REPORT_MAX_RANGE_DAYS) {
    return `Choose at most ${REPORT_MAX_RANGE_DAYS} days, or narrow to one member for all time.`;
  }
  return null;
}

/** The API parameters for `GET /check-ins` and `/check-ins/summary`, paging aside. */
export function historyQuery(
  filters: HistoryFilters,
  today: CivilDate,
): {
  from?: string;
  to?: string;
  userId?: string;
  q?: string;
  entryType?: string;
  method?: string;
  openOnly?: boolean;
  includeVoided?: boolean;
} {
  const window = windowOf(filters, today);
  const q = filters.q.trim();
  return {
    ...(window === null ? {} : { from: window.from, to: window.to }),
    ...(filters.member === null ? {} : { userId: filters.member }),
    // The server needs two characters; one would match nearly everybody.
    ...(q.length >= 2 ? { q } : {}),
    ...(filters.type === '' ? {} : { entryType: filters.type }),
    ...(filters.how === '' ? {} : { method: filters.how }),
    ...(filters.status === 'inside' ? { openOnly: true } : {}),
    ...(filters.status === 'voided' ? { includeVoided: true } : {}),
  };
}

/**
 * The totals' parameters: the list's, except "Include voided" — voided visits
 * are shown on request but never counted.
 */
export function summaryQuery(
  filters: HistoryFilters,
  today: CivilDate,
): Omit<ReturnType<typeof historyQuery>, 'includeVoided'> {
  return historyQuery(
    { ...filters, status: filters.status === 'voided' ? '' : filters.status },
    today,
  );
}

/** How many filters narrow the list beyond the period — the "Clear filters" cue. */
export function activeFilterCount(filters: HistoryFilters): number {
  return [
    filters.member !== null,
    filters.q.trim() !== '',
    filters.type !== '',
    filters.how !== '',
    filters.status !== '',
  ].filter(Boolean).length;
}

/** `got-attendance-ana-reyes-2026-10-01-to-2026-10-31`, or `…-all-time`. */
export function csvFileStem(
  filters: HistoryFilters,
  today: CivilDate,
  memberName: string | null,
): string {
  const window = windowOf(filters, today);
  const who =
    memberName === null
      ? ''
      : `${memberName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')}-`;
  return `got-attendance-${who}${window === null ? 'all-time' : `${window.from}-to-${window.to}`}`;
}
