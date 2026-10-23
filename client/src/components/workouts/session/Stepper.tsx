'use client';

import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * − value + with a TYPEABLE centre (spec §5): steppers for a gloved thumb,
 * the box for "I did 82.5 today". The box holds its own text while it has
 * focus and hands it to `onCommit` on blur or Enter; Escape puts it back.
 * `onCommit` decides what the text means (`parseWeightInput` /
 * `parseRepsInput`) and ignores what it cannot read, so a stray keystroke
 * reverts rather than logging nonsense.
 *
 * 44×44px steps — a thumb target on a phone. SetTable stacks KG over REPS on
 * a narrow card so the box between them still fits "102.5"; there `unit`
 * shows inside the box because the column headers are off screen.
 */
export function Stepper({
  display,
  placeholder,
  inputMode,
  inputLabel,
  downLabel,
  upLabel,
  onStep,
  onCommit,
  unit,
  className,
}: {
  /** What the box shows when it is not being typed in. */
  display: string;
  placeholder?: string;
  inputMode: 'decimal' | 'numeric';
  inputLabel: string;
  downLabel: string;
  upLabel: string;
  onStep: (direction: 1 | -1) => void;
  onCommit: (text: string) => void;
  /** Shown in the box on a narrow card, where the KG/REPS headers are hidden. */
  unit?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);

  const step =
    'h-11 min-w-0 cursor-pointer border-0 bg-transparent p-0 text-[19px] font-semibold text-[color:var(--p-ink)] transition-colors hover:text-foreground focus-visible:rounded-[8px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gold active:bg-[rgba(26,26,26,0.05)] motion-reduce:transition-none';

  return (
    <div
      role="cell"
      className={cn(
        'relative grid h-11 grid-cols-[44px_minmax(0,1fr)_44px] items-center rounded-[9px] border border-[rgba(26,26,26,0.08)] bg-[#f7f6f3] focus-within:border-gold focus-within:shadow-[0_0_0_2px_rgba(201,146,42,0.3)]',
        className,
      )}
    >
      <button type="button" aria-label={downLabel} className={step} onClick={() => onStep(-1)}>
        −
      </button>
      <input
        type="text"
        inputMode={inputMode}
        enterKeyHint="done"
        autoComplete="off"
        aria-label={inputLabel}
        placeholder={placeholder}
        value={draft ?? display}
        onFocus={(event) => {
          cancelled.current = false;
          setDraft(display);
          event.currentTarget.select();
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (!cancelled.current && draft !== null && draft !== display) onCommit(draft);
          cancelled.current = false;
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            cancelled.current = true;
            event.currentTarget.blur();
          }
        }}
        className={cn(
          'h-11 w-full min-w-0 border-0 bg-transparent p-0 text-center font-display text-[16px] font-bold text-foreground tabular-nums outline-none',
          // "BW" is the value, not a hint: it reads exactly like a number.
          'placeholder:text-foreground placeholder:opacity-100',
          // Lift the value to make room for the unit under it.
          unit !== undefined && '@max-[379px]:pb-3 @max-[379px]:leading-none',
        )}
      />
      {unit === undefined ? null : (
        // Under the value, not beside it: at 320px the box is ~72px wide
        // and a unit at its right edge sat on top of "102.5".
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-11 bottom-[3px] hidden text-center text-[11px] leading-none font-bold tracking-[0.12em] text-ink-3 @max-[379px]:block"
        >
          {unit}
        </span>
      )}
      <button type="button" aria-label={upLabel} className={step} onClick={() => onStep(1)}>
        +
      </button>
    </div>
  );
}
