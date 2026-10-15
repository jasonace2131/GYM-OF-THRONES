'use client';

import { useMemo, useState } from 'react';
import type { MembershipListItem } from '@/lib/adminApi';
import { monthGrid } from '@/lib/monthGrid';

/**
 * The renewals calendar — a month grid of the days memberships end.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY RENEWALS AND NOT CLASSES.
 *
 * The reference this dashboard was designed against shows a calendar of
 * lessons. There is no Class, Session or Booking model in this system and no
 * endpoint returns anything schedulable, so that calendar would be decoration
 * pretending to be data — the exact thing the CRM rule forbids. Expiry dates
 * are the highest-value date-keyed data the gym actually holds, and "who do I
 * call today" is a real recurring job. This IS the renewal call sheet, laid
 * out on a month.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Everything is computed from `endsOn`, a gym-local CivilDate ('YYYY-MM-DD')
 * compared and sliced AS A STRING. It is never parsed into a Date: `new
 * Date('2026-08-24')` is UTC midnight, which in Manila is 8 AM on the 24th and
 * renders as the 23rd for anyone west of the gym. The whole class of
 * off-by-one-day calendar bugs lives in that constructor.
 */

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** 'YYYY-MM' for the month a CivilDate falls in. */
function monthOf(day: string): string {
  return day.slice(0, 7);
}

function monthLabel(month: string): string {
  const [year, mon] = month.split('-');
  const name = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(year), Number(mon) - 1, 1)),
  );
  return `${name} ${year}`;
}

function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year!, mon! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface RenewalsCalendarProps {
  items: MembershipListItem[];
  /** Gym-local today, so "past" is decided in the gym's timezone. */
  today: string;
  selected: string | null;
  onSelect: (day: string | null) => void;
  /** True when the 90-day window was wider than the two pages we fetched. */
  truncated?: boolean;
}

export function RenewalsCalendar({
  items,
  today,
  selected,
  onSelect,
  truncated = false,
}: RenewalsCalendarProps) {
  const [month, setMonth] = useState(() => monthOf(today));

  const byDay = useMemo(() => {
    const map = new Map<string, MembershipListItem[]>();
    for (const item of items) {
      const list = map.get(item.endsOn);
      if (list === undefined) map.set(item.endsOn, [item]);
      else list.push(item);
    }
    return map;
  }, [items]);

  // The fetched window is today → +90 days, so months outside it hold no data
  // we could draw. Disabling the arrow is honest; letting someone page into an
  // empty December implies the gym has no December renewals.
  const windowMonths = useMemo(() => {
    const months = new Set([monthOf(today)]);
    for (const day of byDay.keys()) months.add(monthOf(day));
    return [...months].sort();
  }, [byDay, today]);

  const canGoBack = month > windowMonths[0]!;
  const canGoForward = month < windowMonths[windowMonths.length - 1]!;

  const cells = useMemo(() => monthGrid(month), [month]);

  return (
    <div className="a-cal">
      <div className="a-cal-head">
        <div>
          <h3 className="a-card-title">Renewals</h3>
          <p className="a-card-sub">{monthLabel(month)}</p>
        </div>
        <div className="a-cal-nav">
          <button
            type="button"
            className="a-cal-arrow"
            onClick={() => setMonth(shiftMonth(month, -1))}
            disabled={!canGoBack}
            aria-label="Previous month"
          >
            ‹
          </button>
          <button
            type="button"
            className="a-cal-arrow"
            onClick={() => setMonth(shiftMonth(month, 1))}
            disabled={!canGoForward}
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      </div>

      <div className="a-cal-grid" role="grid" aria-label={`Renewals in ${monthLabel(month)}`}>
        {WEEKDAYS.map((letter, index) => (
          <span key={index} className="a-cal-dow" aria-hidden>
            {letter}
          </span>
        ))}

        {cells.map(({ day, inMonth }) => {
          const expiries = byDay.get(day) ?? [];
          const count = expiries.length;
          const lapsed = day < today;
          const isToday = day === today;
          const isSelected = day === selected;

          if (!inMonth) {
            return (
              <span key={day} className="a-cal-day" data-mute aria-hidden>
                {Number(day.slice(8))}
              </span>
            );
          }

          const label =
            count === 0
              ? `${day}, no renewals`
              : `${day}, ${count} membership${count === 1 ? '' : 's'} ending`;

          return (
            <button
              key={day}
              type="button"
              className="a-cal-day"
              role="gridcell"
              data-today={isToday || undefined}
              data-has={count > 0 || undefined}
              data-selected={isSelected || undefined}
              aria-label={label}
              // `aria-selected`, not `aria-pressed`: this is a gridcell in a
              // date grid, not a toggle button, and gridcell does not support
              // the pressed state.
              aria-selected={isSelected}
              // Clicking the selected day again clears the filter, so there is
              // always a way back to the full week without hunting for a
              // "clear" control.
              onClick={() => onSelect(isSelected ? null : day)}
              disabled={count === 0}
            >
              {Number(day.slice(8))}
              {count > 0 && <i data-tone={lapsed ? 'danger' : 'warn'} aria-hidden />}
            </button>
          );
        })}
      </div>

      <div className="a-cal-legend">
        <span>
          <i data-tone="warn" aria-hidden />
          Ending
        </span>
        <span>
          <i data-tone="danger" aria-hidden />
          Lapsed
        </span>
        <span className="a-cal-hint">
          {selected === null ? 'Click a day' : 'Click again to clear'}
        </span>
      </div>

      {truncated && (
        <p className="a-cal-truncated">
          Showing the first 200 renewals in the next 90 days.
        </p>
      )}
    </div>
  );
}
