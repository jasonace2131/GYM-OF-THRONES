'use client';

import { useCallback } from 'react';
import { adminApi } from '@/lib/adminApi';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { RANGE_PRESETS, presetRange, type RangeKey } from '@/lib/payments/rangePresets';

/**
 * The register's filters.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ZERO SERVER WORK FOR ALL OF THIS BUT `archived`.
 *
 * `ListPaymentsQueryDto` has accepted `from`, `to`, `status`, `method`,
 * `discountType`, `shiftId`, `userId` and `planCode` since payments shipped,
 * and no screen has ever sent more than `method`. This toolbar is the client
 * catching up with the API it already has.
 *
 * STATUS DEFAULTS TO LIVE, and that is the biggest readability win available
 * here: the register mixed voided rows into live ones with nothing but a red
 * badge to tell them apart, and every amend adds one more voided row.
 *
 * `shiftId` is deliberately NOT exposed. There is no `GET /shifts` list to
 * populate a picker from, and a chip reading "Shift 7f2a…" is noise.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type StatusFilter = 'RECORDED' | 'VOIDED' | 'ALL';

export interface PaymentsFilters {
  range: RangeKey;
  from: string;
  to: string;
  status: StatusFilter;
  method: string;
  planCode: string;
  archived: boolean;
}

export const DEFAULT_FILTERS: PaymentsFilters = {
  range: '30d',
  from: '',
  to: '',
  status: 'RECORDED',
  method: '',
  planCode: '',
  archived: false,
};

/**
 * The range a set of filters resolves to.
 *
 * An explicitly typed bound WINS over the preset; an empty one falls back to
 * it. Typing in either input switches the preset to `all` (which contributes
 * no bound of its own), so the typed value stands alone rather than being
 * silently intersected with a window the operator no longer sees selected.
 */
export function resolvedRange(filters: PaymentsFilters, now: Date): { from: string; to: string } {
  const preset = presetRange(filters.range, now);
  return {
    from: filters.from === '' ? preset.from : filters.from,
    to: filters.to === '' ? preset.to : filters.to,
  };
}

export function PaymentsToolbar({
  filters,
  onChange,
}: {
  filters: PaymentsFilters;
  /** Every change resets the pager — the caller owns that. */
  onChange: (next: PaymentsFilters) => void;
}) {
  const plansQuery = useAdminQuery(useCallback(() => adminApi.plans(), []), 'payments-plans');
  const plans = plansQuery.data?.items ?? [];

  const set = <K extends keyof PaymentsFilters>(key: K, value: PaymentsFilters[K]): void =>
    onChange({ ...filters, [key]: value });

  const range = presetRange(filters.range, new Date());

  const isDefault =
    filters.range === DEFAULT_FILTERS.range &&
    filters.from === '' &&
    filters.to === '' &&
    filters.status === DEFAULT_FILTERS.status &&
    filters.method === '' &&
    filters.planCode === '' &&
    !filters.archived;

  /*
   * TWO ROWS ON ONE GRID (owner, 2026-10-08: "align these boxes").
   *
   * Period on top, the four filters under it, each row behind a fixed-width
   * label so both start on the same vertical line. Every control is the same
   * 40px tall, and FROM/TO sit INSIDE one date-range box instead of above two
   * — a label stacked over an input made those two boxes taller and lower
   * than everything beside them.
   */
  return (
    <div className="a-filters" role="group" aria-label="Filter payments">
      <div className="a-filters-row">
        <span className="a-filters-label" aria-hidden>
          Period
        </span>
        <div className="a-filters-controls">
          <div className="a-range" role="radiogroup" aria-label="Date range">
            {RANGE_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                role="radio"
                aria-checked={
                  filters.range === preset.key && filters.from === '' && filters.to === ''
                }
                className="a-range-btn"
                onClick={() => onChange({ ...filters, range: preset.key, from: '', to: '' })}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* Typing in either date overrides the preset — `range: 'all'` sends
              no bound of its own, so the typed value stands alone rather than
              being intersected with a preset window. */}
          <div className="a-daterange">
            <label className="a-daterange-part">
              <span className="a-daterange-tag">From</span>
              <input
                type="date"
                className="a-daterange-input"
                value={filters.from === '' ? range.from : filters.from}
                onChange={(event) =>
                  onChange({ ...filters, range: 'all', from: event.target.value })
                }
              />
            </label>
            <span className="a-daterange-sep" aria-hidden>
              –
            </span>
            <label className="a-daterange-part">
              <span className="a-daterange-tag">To</span>
              <input
                type="date"
                className="a-daterange-input"
                value={filters.to === '' ? range.to : filters.to}
                onChange={(event) => onChange({ ...filters, range: 'all', to: event.target.value })}
              />
            </label>
          </div>
        </div>
      </div>

      <div className="a-filters-row">
        <span className="a-filters-label" aria-hidden>
          Show
        </span>
        <div className="a-filters-controls a-filters-selects">
          <select
            className="a-filters-select"
            value={filters.status}
            aria-label="Filter by status"
            onChange={(event) => set('status', event.target.value as StatusFilter)}
          >
            <option value="RECORDED">Live</option>
            <option value="VOIDED">Voided</option>
            <option value="ALL">All statuses</option>
          </select>

          <select
            className="a-filters-select"
            value={filters.method}
            aria-label="Filter by method"
            onChange={(event) => set('method', event.target.value)}
          >
            <option value="">All methods</option>
            <option value="CASH">Cash</option>
            <option value="GCASH">GCash</option>
          </select>

          <select
            className="a-filters-select"
            value={filters.planCode}
            aria-label="Filter by plan"
            disabled={plansQuery.loading}
            onChange={(event) => set('planCode', event.target.value)}
          >
            <option value="">All plans</option>
            {plans.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name}
              </option>
            ))}
          </select>

          <select
            className="a-filters-select"
            value={filters.archived ? 'show' : 'hide'}
            aria-label="Archived payments"
            onChange={(event) => set('archived', event.target.value === 'show')}
          >
            <option value="hide">Hide archived</option>
            <option value="show">Archived only</option>
          </select>
        </div>

        {isDefault ? null : (
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm a-filters-reset"
            onClick={() => onChange(DEFAULT_FILTERS)}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
