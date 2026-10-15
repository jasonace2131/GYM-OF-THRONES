'use client';

import { useState } from 'react';
import { TZDate } from '@date-fns/tz';
import { Calendar } from '@/components/ui/calendar';
import { GYM_TIMEZONE, type CivilDate } from '@/lib/gymTime';
import { applyRangeClick, type RangeDraft } from '@/lib/reportRange';

/**
 * A two-month range grid for the reports window.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS WHY THE ADMIN CONSOLE NOW LOADS TAILWIND.
 *
 * react-day-picker gives arrow-key navigation, Home/End, PageUp/PageDown,
 * `role="grid"`, per-day `aria-selected` and a live-announced caption — all
 * of it for free, and none of it present in a hand-rolled month of buttons.
 * The alternative was reimplementing a roving tabindex and an ARIA grid in
 * the CRM, which is a fortnight of work to arrive somewhere worse.
 *
 * It is in `components/admin/range/` because that is the ONLY admin folder
 * `tailwind.css` scans. A Tailwind class in any other admin file generates
 * nothing; a legacy `a-*` class here is still safe because the containment
 * gate checks the other direction. Do not widen the @source line.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── COLOURS ──
 * Nothing here carries a hex. shadcn's variables are defined under
 * `.portal-root`, and the CRM shell is `.portal-root .admin-root`, so
 * `--primary` is already the gym's gold and `--accent` its gold film. The
 * range fill and the two endpoints come from `components/ui/calendar.tsx`'s
 * `data-range-*` attributes, which is also why the endpoint styling is NOT
 * re-derived here: react-day-picker puts `modifiersClassNames` on the day
 * CELL, one level above the button that actually paints, and shadcn's
 * `DayButton` slot is the fix that is already in the file.
 *
 * ── SELECTION ──
 * The click rule is `applyRangeClick`, not react-day-picker's own, and the
 * difference is deliberate: clicking before an open start RESTARTS the
 * selection rather than extending backwards into a reversed range. So
 * `selected` is fully controlled from the draft and `onDayClick` drives it.
 */

/** A gym day as a Date at Manila midnight, which react-day-picker expects with `timeZone`. */
function toDate(day: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new TZDate(year, month - 1, date, GYM_TIMEZONE);
}

/**
 * The anchor for a displayed month, at UTC NOON on the 1st.
 *
 * Not a TZDate at Manila midnight: that is 16:00 UTC on the LAST day of the
 * previous month, and react-day-picker read it as that month — the picker
 * opened on August for a September range. Noon is the 1st in every zone
 * within ±12 hours of UTC, so the caption cannot land a month early.
 */
function monthAnchor(yyyymm: string): Date {
  const [year, month] = yyyymm.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 1, 1, 12));
}

/** 'YYYY-MM' one month before the one holding `day`. */
function previousMonthOf(day: string): string {
  const [year, month] = day.slice(0, 7).split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, month - 2, 1, 12));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The gym-local civil day of a Date, never `toISOString().slice(0, 10)`. */
function toDay(value: Date): CivilDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: GYM_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value) as CivilDate;
}

export interface RangeCalendarProps {
  draft: RangeDraft;
  onDraft: (next: RangeDraft) => void;
  /** Gym-local today. Nothing after it is selectable. */
  today: CivilDate;
}

export function RangeCalendar({ draft, onDraft, today }: RangeCalendarProps) {
  // The RIGHT pane opens on the month holding the end of the range, so the
  // left one is the month before it. Anchoring the left pane on the selection
  // instead would spend the right pane on a month that is entirely in the
  // future, and every future day is disabled — a dead half of the widget.
  const [month, setMonth] = useState(() => monthAnchor(previousMonthOf(draft.to ?? draft.from)));

  return (
    <Calendar
      mode="range"
      timeZone={GYM_TIMEZONE}
      weekStartsOn={1}
      numberOfMonths={2}
      showOutsideDays={false}
      month={month}
      onMonthChange={setMonth}
      // Future days cannot be part of a report window: `averagePerDay`
      // divides by the days in range, so a range running past today divides
      // by days that have not happened.
      disabled={{ after: toDate(today) }}
      selected={{
        from: toDate(draft.from),
        to: draft.to === null ? undefined : toDate(draft.to),
      }}
      // Fully controlled from `draft`; react-day-picker's own range logic is
      // deliberately bypassed. See the header.
      onSelect={() => undefined}
      onDayClick={(day, modifiers) => {
        if (modifiers.disabled === true) return;
        onDraft(applyRangeClick(draft, toDay(day)));
      }}
      className="w-full p-0 [--cell-size:2rem]"
      // `relative` is NOT decoration and must not be dropped from this
      // override: react-day-picker's month nav is `absolute inset-x-0 top-0`,
      // so without a positioned ancestor here the two chevrons escape the
      // calendar entirely and land on the modal's own header, on top of the
      // title and the close button.
      classNames={{ months: 'relative flex flex-col gap-4 sm:flex-row sm:gap-5' }}
    />
  );
}
