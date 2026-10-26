'use client';

import { useEffect, useState } from 'react';
import { Modal, ModalError } from '@/components/admin/Modal';
import { civilDaysBetween, type CivilDate } from '@/lib/gymTime';
import {
  rangeLabel,
  validateRange,
  type DateRange,
  type RangeDraft,
} from '@/lib/reportRange';
import { RangeCalendar } from './RangeCalendar';

/**
 * Pick a custom reporting window.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A MODAL, NOT AN INLINE POPOVER, AND THAT IS A LAYOUT DECISION WITH A SCAR.
 *
 * `admin.css` documents that `.a-scroll`'s overflow pair clips absolutely
 * positioned descendants regardless of z-index — every table on the reports
 * screen sits inside one. A popover anchored to the toolbar would render, be
 * measured as visible, and be sliced at the card edge. `Modal`'s backdrop is
 * `position: fixed` at page level, so it is clear of every clipping context
 * on the page by construction.
 *
 * It also buys the whole dialog contract for free — focus trap, focus
 * restore on close, Escape, `role="dialog"`, `aria-modal`, body scroll lock —
 * which the two hand-rolled overlays elsewhere in this console do not have.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── THE TYPED PATH IS THE ACCESSIBLE ONE ──
 * The two native `<input type="date">` fields are not a convenience beside
 * the grid; they are the primary control for anyone not using a mouse. A
 * native date input carries the platform's own keyboard entry, screen-reader
 * labelling and mobile picker. That is why the grid needs no roving-tabindex
 * work of its own beyond what react-day-picker already provides: there is
 * always a way in that does not depend on it.
 *
 * ── APPLY IS DISABLED, NOT FORGIVING ──
 * While the range is half-built (`to === null`) or `validateRange` has
 * something to say, Apply is off and the reason is on screen in a
 * `role="alert"`. The alternative is a round trip that returns a 400 written
 * for an API caller, after the calendar has closed.
 */

export interface DateRangeModalProps {
  open: boolean;
  /** The window the screen is currently showing, used as the starting draft. */
  initial: DateRange;
  /** Gym-local today. Nothing after it is selectable or valid. */
  today: CivilDate;
  onClose: () => void;
  onApply: (range: DateRange) => void;
}

export function DateRangeModal({ open, initial, today, onClose, onApply }: DateRangeModalProps) {
  const [draft, setDraft] = useState<RangeDraft>({ from: initial.from, to: initial.to });

  // Reopening starts from whatever the screen is showing now, not from the
  // half-finished selection that was abandoned last time.
  useEffect(() => {
    if (open) setDraft({ from: initial.from, to: initial.to });
  }, [open, initial.from, initial.to]);

  const complete = draft.to === null ? null : { from: draft.from, to: draft.to };
  const problem = complete === null ? null : validateRange(complete, today);
  const canApply = complete !== null && problem === null;

  // Both bounds inclusive, matching the server: from === to is one day.
  const days = complete === null ? null : civilDaysBetween(complete.from, complete.to) + 1;

  return (
    <Modal
      open={open}
      wide
      title="Custom date range"
      subtitle="Both dates are included in the report."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="p-btn p-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="p-btn p-btn-gold"
            disabled={!canApply}
            onClick={() => {
              if (complete !== null) onApply(complete);
            }}
          >
            Apply range
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 16 }}>
        {/* Side by side; one column on a narrow phone (admin.css). */}
        <div className="a-grid-2">
          <div className="a-field">
            <label className="a-field-label" htmlFor="range-from">
              From
            </label>
            <input
              id="range-from"
              className="a-input"
              type="date"
              value={draft.from}
              max={draft.to ?? today}
              onChange={(event) => {
                const value = event.target.value;
                if (value === '') return;
                setDraft((current) => ({ ...current, from: value as CivilDate }));
              }}
            />
          </div>

          <div className="a-field">
            <label className="a-field-label" htmlFor="range-to">
              To
            </label>
            <input
              id="range-to"
              className="a-input"
              type="date"
              value={draft.to ?? ''}
              min={draft.from}
              max={today}
              onChange={(event) => {
                const value = event.target.value;
                setDraft((current) => ({
                  ...current,
                  to: value === '' ? null : (value as CivilDate),
                }));
              }}
            />
          </div>
        </div>

        <RangeCalendar draft={draft} onDraft={setDraft} today={today} />

        {/* Said in days as well as in dates: "1 Sep – 22 Sep" does not tell
            anybody at a glance that they are about to average over 22 days,
            and the day count is what `averagePerDay` divides by. */}
        <p className="a-field-hint" style={{ fontSize: 13 }} aria-live="polite">
          {complete === null ? (
            'Pick the end of the range.'
          ) : (
            <>
              <strong style={{ color: 'var(--p-ink)' }}>
                {days} {days === 1 ? 'day' : 'days'}
              </strong>{' '}
              · {rangeLabel(complete)}
            </>
          )}
        </p>

        <ModalError message={problem} />
      </div>
    </Modal>
  );
}
