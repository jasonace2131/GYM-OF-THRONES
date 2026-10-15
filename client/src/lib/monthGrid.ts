/**
 * The days of a 'YYYY-MM' month, padded to whole Monday-start weeks.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BUILT WITH Date.UTC AND EMITTED AS STRINGS, AND THAT IS THE WHOLE RULE.
 *
 * `new Date('2026-08-24')` is UTC midnight, which in Manila is 8 AM on the
 * 24th and renders as the 23rd for anyone west of the gym. The whole class of
 * off-by-one-day calendar bugs lives in that constructor. Every date here is
 * constructed with `Date.UTC` and leaves as a `yyyy-mm-dd` string, so nothing
 * downstream can reinterpret it in the viewer's zone.
 *
 * Monday first: a week that starts on Sunday reads as an American calendar to
 * a Philippine audience.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Lifted out of `components/admin/dashboard/RenewalsCalendar.tsx`, which is
 * now the first of two callers. It is here rather than there because a pure
 * function in a `'use client'` component is a function vitest cannot reach —
 * `client/vitest.config.ts` renders no React, by design — and this one carries
 * the rule above, which is exactly the kind that needs a test.
 *
 * ── THE TRAIL LOOP IS FIXED, NOT LIFTED ──
 * The original read `daysInMonth + (cells.length % 7)`, using the running
 * length as the day offset. That is only right when exactly six trail cells
 * are needed; every other month it starts partway through the next month and
 * skips the days before it. September 2026's renewals grid ended
 * "3 4 5 6 October" instead of "1 2 3 4", and February 2026's single trail
 * cell read "6 March" instead of "1 March" — so a renewal due on 1 October
 * appeared in no trailing row at all while one due on the 6th appeared twice,
 * in September's grid and again in October's. Greyed cells on a call sheet
 * are still a call sheet.
 */
export interface MonthGridCell {
  /** A gym-local civil date, 'yyyy-mm-dd'. */
  day: string;
  /** False for the lead and trail cells borrowed from the neighbouring months. */
  inMonth: boolean;
}

export function monthGrid(month: string): MonthGridCell[] {
  const [year, mon] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year!, mon! - 1, 1));
  const daysInMonth = new Date(Date.UTC(year!, mon!, 0)).getUTCDate();

  // getUTCDay() is 0=Sunday; the grid starts on Monday.
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: MonthGridCell[] = [];

  const push = (date: Date, inMonth: boolean): void => {
    cells.push({ day: date.toISOString().slice(0, 10), inMonth });
  };

  for (let i = lead; i > 0; i -= 1) push(new Date(Date.UTC(year!, mon! - 1, 1 - i)), false);
  for (let d = 1; d <= daysInMonth; d += 1) push(new Date(Date.UTC(year!, mon! - 1, d)), true);
  // `trail` counts from 1 rather than from the running length — see the
  // header. Day `daysInMonth + n` rolls into the next month via Date.UTC.
  for (let trail = 1; cells.length % 7 !== 0; trail += 1) {
    push(new Date(Date.UTC(year!, mon! - 1, daysInMonth + trail)), false);
  }

  return cells;
}
