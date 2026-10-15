import { REPORT_MAX_RANGE_DAYS } from '@got/shared';
import { addDays, civilDaysBetween, formatCivilDate, type CivilDate } from './gymTime';

/**
 * The reports screen's date window: presets, drafting, validation, labels.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ALL OF IT IS PURE, AND NONE OF IT LIVES IN A COMPONENT.
 *
 * `client/vitest.config.ts` says "nothing here renders React yet", and there
 * is no `@testing-library/react`. Date arithmetic hidden inside a component
 * is date arithmetic no test can reach — which is exactly how "Last 7 days"
 * shipped meaning eight and stayed that way. Anything here that decides a
 * date is a function in this file with a test beside it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every bound is INCLUSIVE, matching the server: `walkInStats` divides by
 * `civilDaysBetween(from, to) + 1`. A preset that forgets that is a preset
 * whose averages are quietly wrong by a ratio.
 */

export type Preset = '7d' | '30d' | 'month' | '90d' | '12m' | 'custom';

export interface DateRange {
  from: CivilDate;
  to: CivilDate;
}

/**
 * The window a preset asks for, both bounds inclusive.
 *
 * ── THE BUG THIS REPLACES ──
 * `reports/page.tsx` had `from = shiftDays(7)`, `to = today`. Inclusive, that
 * is EIGHT days, and the server's `averagePerDay` divides by its own
 * inclusive count — so every average on the screen was out by 7/8. Small
 * enough to read as ordinary variance, which is why it survived.
 *
 * ── AND WHY 'month' STOPS AT TODAY ──
 * Not month-end. A range running into the future divides the average by days
 * that have not happened: on the 3rd of a 31-day month the screen would
 * report a tenth of the real daily figure, against a total that was right.
 */
export function rangeForPreset(preset: Exclude<Preset, 'custom'>, today: CivilDate): DateRange {
  if (preset === '7d') return { from: addDays(today, -6), to: today };
  if (preset === '30d') return { from: addDays(today, -29), to: today };
  if (preset === '90d') return { from: addDays(today, -89), to: today };
  if (preset === '12m') return { from: firstOfMonthsBack(today, 11), to: today };
  return { from: `${today.slice(0, 7)}-01` as CivilDate, to: today };
}

/**
 * The 1st of the month `months` before `today`'s month.
 *
 * '12m' is twelve CALENDAR months — the Revenue tab groups by month, and a
 * window starting mid-month would clip its first row. At most 365 days, so
 * it stays inside `REPORT_MAX_RANGE_DAYS`.
 */
function firstOfMonthsBack(today: CivilDate, months: number): CivilDate {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1 - months;
  const shifted = new Date(Date.UTC(year, month, 1));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01` as CivilDate;
}

/**
 * A range mid-selection. `to === null` means the user has picked a start and
 * not yet a finish — the state Apply must refuse and the grid must render as
 * an open range rather than a single selected day.
 */
export interface RangeDraft {
  from: CivilDate;
  to: CivilDate | null;
}

/**
 * The calendar's click rule.
 *
 * Three cases, and the third is the one worth stating: clicking BEFORE an
 * open start restarts the selection rather than producing a reversed range.
 * Somebody who clicks the 20th and then realises they meant the 5th is
 * correcting the start, not selecting backwards — and a reversed draft would
 * only surface as a 400 after they pressed Apply.
 */
export function applyRangeClick(draft: RangeDraft, day: CivilDate): RangeDraft {
  if (draft.to !== null) return { from: day, to: null };
  if (day < draft.from) return { from: day, to: null };
  return { from: draft.from, to: day };
}

/**
 * Why Apply is disabled, or null when it is not.
 *
 * Mirrors `resolveDateWindow` on the server, plus `to <= today`. Checking
 * here rather than letting the request 400 is not belt-and-braces: the
 * server's three messages are written for an API caller, and translating one
 * back into something a staffer mid-selection can act on is work the modal
 * would have to do anyway — after a round trip, with the calendar already
 * closed.
 */
export function validateRange(range: DateRange, today: CivilDate): string | null {
  const span = civilDaysBetween(range.from, range.to);

  if (span < 0) return 'The start date must be on or before the end date.';
  if (range.to > today) return 'The end date cannot be in the future.';
  if (span > REPORT_MAX_RANGE_DAYS) {
    return `Ask for at most ${REPORT_MAX_RANGE_DAYS} days at a time.`;
  }
  return null;
}

/**
 * '16 Sep 2026 – 22 Sep 2026', and never an ISO pair.
 *
 * An en dash, not a hyphen: a hyphen already appears twice inside each ISO
 * date, and '2026-09-16 - 2026-09-22' is unparseable at a glance — which
 * matters most on a PDF footnote, where this is the only thing telling a
 * reader which window the table above them describes.
 *
 * A one-day range collapses to a single date. '22 Sep 2026 – 22 Sep 2026'
 * reads as a mistake.
 */
export function rangeLabel(range: DateRange): string {
  const from = formatCivilDate(range.from);
  if (range.from === range.to) return from;
  return `${from} – ${formatCivilDate(range.to)}`;
}

/**
 * '2026-09-16-to-2026-09-22' — the stem of a downloaded file.
 *
 * ISO here, deliberately: a file name is read by a folder listing, and ISO is
 * the only form that sorts chronologically when it does.
 */
export function rangeFileStem(range: DateRange): string {
  return `${range.from}-to-${range.to}`;
}
