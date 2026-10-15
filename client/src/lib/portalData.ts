/**
 * Member portal data.
 *
 * Every screen here reads live from the API: the subscription screen
 * (`/me/membership`, `/plans`, `/me/payments`), the pay screen and the
 * check-in history. The dashboard's loader lives in `lib/dashboard/` and the
 * announcements feed in `lib/announcements/`. There is no mock data left in
 * this file, and none may be added back.
 */

import {
  DiscountType,
  MembershipStatus,
  PaymentMethod,
  PaymentStatus,
  PlanKind,
  type AccessDecision,
  type AllowReason,
  type AccessVerdict,
  type CivilDate,
  type DenialReason,
  type MyCheckIn,
  type PublicGymConfig,
  type MyCheckInSummary,
  type PaginatedData,
} from '@got/shared';
import { apiFetch } from './api';
import { GYM_TIMEZONE, formatGymTime, gymToday, toDateColumn } from './gymTime';

// ── Live contracts (mirror the server presenters; see §5.11) ──────────

export interface PublicPlan {
  code: string;
  name: string;
  description: string | null;
  kind: PlanKind;
  priceCentavos: number;
  termMonths: number | null;
  guestPassesPerTerm: number;
  perks: string[];
  sortOrder: number;
}

export interface AccessResult {
  decision: AccessDecision;
  verdict: AccessVerdict | null;
  allowReason: AllowReason | null;
  denialReason: DenialReason | null;
  message: string;
  relevantDate: CivilDate | null;
  daysRemaining: number | null;
  graceDaysRemaining: number;
  offer: 'NONE' | 'RENEW' | 'UNFREEZE' | 'OVERRIDE' | 'MANAGER';
}

export interface MembershipDetail {
  id: string;
  planCode: string;
  planName: string;
  planPriceCentavos: number;
  termMonths: number;
  status: MembershipStatus;
  startsOn: CivilDate;
  endsOn: CivilDate;
  graceDays: number;
  cancelRequestedOn: CivilDate | null;
  guestPassesRemaining: number;
  verdict: AccessResult;
}

export interface PaymentSummary {
  id: string;
  businessDate: CivilDate;
  netCentavos: number;
  method: PaymentMethod;
  status: PaymentStatus;
  discountType: DiscountType;
  reference: string | null;
  receiptNo: string | null;
}

export interface SubscriptionView {
  membership: MembershipDetail | null;
  verdict: AccessResult;
  plans: PublicPlan[];
  payments: PaymentSummary[];
}

interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ── Formatting — the client's only job (spec 3.3 rule 1) ─────────────

const PESO = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });

/**
 * The ONE place a peso string is composed, from an integer of centavos the
 * server sent. No response body anywhere carries a formatted currency string,
 * so no screen may invent a second formatting rule.
 */
export function formatCentavos(centavos: number): string {
  return PESO.format(centavos / 100);
}

/**
 * A server civil date, formatted with UTC accessors.
 *
 * A @db.Date arrives as 'yyyy-mm-dd' and means a gym-local business day.
 * Reading it with device-local accessors is the iso() bug: every 00:00–08:00
 * Manila render would show the previous day.
 */
export function formatCivilDate(day: CivilDate | string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(toDateColumn(day as CivilDate));
}

// ── Live API ─────────────────────────────────────────────────────────

/**
 * §9.11 steps 1 and 2: membership, plans and payments all come from the
 * server. There is no mock branch and no flag — the screen flips fully or not
 * at all.
 */
export async function getSubscription(): Promise<SubscriptionView> {
  const [mine, plans, payments] = await Promise.all([
    apiFetch<{ membership: MembershipDetail | null; verdict: AccessResult }>('/me/membership'),
    apiFetch<PublicPlan[]>('/plans'),
    apiFetch<Paginated<PaymentSummary>>('/me/payments?page=1&limit=12'),
  ]);

  return {
    membership: mine.membership,
    verdict: mine.verdict,
    plans,
    payments: payments.items,
  };
}

// ── Types ────────────────────────────────────────────────

/** One day in the consistency heatmap. */
export interface CheckInDay {
  /** ISO yyyy-mm-dd */
  date: string;
  /** 0 = no visit. Higher values shade darker. */
  visits: number;
}

/**
 * `/portal/pay` — read-only, by design.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING IN THE PORTAL MAY POST A PURCHASE (design decision #9).
 *
 * Payments are staff-recorded only: cash, or a GCash reference typed by staff
 * at the counter. Every peso lands in a counted till against an open shift,
 * entered by a person who saw it. A portal that could take money would create
 * rows the drawer never saw, and the first blind close that came up ₱800 short
 * would have no explanation.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface PayData {
  /** Null when the gym has not configured GCash. NEVER a placeholder. */
  gcashNumber: string | null;
  gcashName: string | null;
  openTime: string;
  closeTime: string;
  /** The live price list. A member is quoted from this, never from the client. */
  plans: PublicPlan[];
  /** Null when they have no membership — a valid, non-error state. */
  currentPlanCode: string | null;
  payments: PaymentSummary[];
}

export interface CheckInRecord {
  id: string;
  date: string;
  day: string;
  timeIn: string;
  timeOut: string | null;
  duration: string;
  status: 'complete' | 'active';
}


// ── Helpers ──────────────────────────────────────────────

/**
 * The server sends a SPARSE list — one entry per day that had a visit — and the
 * heatmap needs every square, including the empty ones. Expanding here rather
 * than on the wire keeps the payload proportional to how often somebody trains
 * instead of to how long the window is.
 *
 * Shared by the dashboard (`lib/dashboard/loadDashboard.ts`) and the check-in
 * history below, so the two views of one member's attendance cannot drift.
 */
export function toHeatmap(summary: MyCheckInSummary): CheckInDay[] {
  const counts = new Map(summary.days.map((day) => [day.date as string, day.count]));
  const days: CheckInDay[] = [];

  const today = new Date();
  for (let back = HEATMAP_DAYS - 1; back >= 0; back -= 1) {
    const at = new Date(today);
    at.setDate(today.getDate() - back);
    const date = gymDateOf(at);
    days.push({ date, visits: counts.get(date) ?? 0 });
  }

  return days;
}

/** 26 weeks, matching the server's own window. */
const HEATMAP_DAYS = 26 * 7;

/**
 * A `Date` as the gym's civil day.
 *
 * Goes through `gymToday` rather than `toISOString().slice(0, 10)` for the
 * usual reason: the gym opens at 05:00 Manila, which is 21:00 UTC the previous
 * day, so the busiest hour of every morning would land in yesterday's square.
 */
function gymDateOf(at: Date): string {
  return gymToday(at, GYM_TIMEZONE);
}

/** `2026-09-19` → `Sep 19, 2026`. Rendered here, never sent by the API. */
function longDate(day: CivilDate): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(toDateColumn(day));
}

// ── API ──────────────────────────────────────────────────

/**
 * LIVE. Four public/own-scope reads, none of which can move money.
 *
 * The GCash number comes from `GET /config` rather than a constant, because
 * the page this replaced hardcoded `0917 123 4567` — a fake number on a
 * payment screen is how a member's money reaches a stranger.
 */
export async function getPayData(): Promise<PayData> {
  const [config, plans, mine, payments] = await Promise.all([
    apiFetch<PublicGymConfig>('/config'),
    apiFetch<PublicPlan[]>('/plans'),
    apiFetch<{ membership: MembershipDetail | null }>('/me/membership'),
    apiFetch<Paginated<PaymentSummary>>('/me/payments?page=1&limit=24'),
  ]);

  return {
    gcashNumber: config.payment.gcashNumber,
    gcashName: config.payment.gcashName,
    openTime: config.openTime,
    closeTime: config.closeTime,
    plans,
    currentPlanCode: mine.membership?.planCode ?? null,
    payments: payments.items,
  };
}

// ── Check-in history ─────────────────────────────────────

export interface CheckInHistoryData {
  checkInsThisMonth: number;
  checkInsAllTime: number;
  avgPerWeek: number;
  longestStreakWeeks: number;
  heatmap: CheckInDay[];
  /** The most recent page. May be shorter than `recordsTotal`. */
  records: CheckInRecord[];
  /**
   * Every non-voided visit, not just the loaded page.
   *
   * The API caps a page at 100 (`PAGINATION_DEFAULTS.MAX_LIMIT`), so a member
   * with a longer history gets a truncated table — and a screen that printed
   * `records.length` as the visit count would quietly tell them they have been
   * to the gym exactly 100 times, forever.
   */
  recordsTotal: number;
}

/**
 * LIVE. Routes 13 and 14.
 *
 * The heatmap and the table are both derived from the SAME server response, so
 * the two views of one member's attendance cannot drift apart — which is the
 * bug the old mock version was written to avoid and then reintroduced by
 * fabricating table rows from heatmap squares.
 */
export async function getCheckInHistory(): Promise<CheckInHistoryData> {
  const [page, summary] = await Promise.all([
    apiFetch<PaginatedData<MyCheckIn>>(`/me/check-ins?limit=${HISTORY_PAGE_LIMIT}`),
    apiFetch<MyCheckInSummary>('/me/check-ins/summary'),
  ]);

  return {
    checkInsThisMonth: summary.thisMonth,
    checkInsAllTime: summary.allTime,
    avgPerWeek: summary.avgPerWeek,
    longestStreakWeeks: summary.longestStreakWeeks,
    heatmap: toHeatmap(summary),
    records: page.items.map(toCheckInRecord),
    recordsTotal: page.total,
  };
}

/** `PAGINATION_DEFAULTS.MAX_LIMIT` — the server rejects anything larger. */
const HISTORY_PAGE_LIMIT = 100;

/**
 * Times render in the GYM's time zone, never the phone's.
 *
 * A member travelling — or simply a handset left on the wrong zone — must see
 * the times the gym saw. `formatGymTime` exists for exactly this and is the
 * only sanctioned way to render an instant on this side.
 */
function toCheckInRecord(visit: MyCheckIn): CheckInRecord {
  const open = visit.endedAt === null;

  return {
    id: visit.id,
    date: longDate(visit.businessDate),
    day: weekdayOf(visit.businessDate),
    timeIn: formatGymTime(visit.occurredAt, GYM_TIMEZONE),
    timeOut: open ? null : formatGymTime(visit.endedAt as string, GYM_TIMEZONE),
    // An open visit has no duration yet, and inventing one from `now` would
    // make a member who forgot to check out look like they trained for nine
    // hours. Auto-close at the gym's closing time is what resolves these.
    duration: visit.durationMinutes === null ? '—' : formatDuration(visit.durationMinutes),
    status: open ? 'active' : 'complete',
  };
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest}m` : `${hours}h ${String(rest).padStart(2, '0')}m`;
}

/** The weekday of a CIVIL date — read at UTC, because that is what it is. */
function weekdayOf(day: CivilDate): string {
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', weekday: 'long' }).format(
    toDateColumn(day),
  );
}
