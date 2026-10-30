'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { IconWarning } from '../icons';

/**
 * The session's bottom bars (PhoneSession.dc.html): Prev / Next exercise /
 * Finish workout, and the "Finish this workout?" / "Discard this workout?"
 * confirmation that takes their place. The rest bar is its own file, and
 * carries Finish workout too on the last exercise.
 *
 * Each bar runs edge to edge; its content is the same 560px column as the
 * card above it, padded clear of the home indicator.
 */

export const BAR_INNER =
  'mx-auto w-full max-w-[560px] px-3.5 pt-3 pb-[max(22px,env(safe-area-inset-bottom))]';

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold';

const GHOST = cn(
  'h-[50px] cursor-pointer rounded-[10px] border-[1.5px] border-[rgba(26,26,26,0.2)] bg-card font-display text-[13.5px] font-bold tracking-[0.06em] text-foreground uppercase transition-colors hover:border-gold disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-[rgba(26,26,26,0.2)] motion-reduce:transition-none',
  FOCUS,
);

const PRIMARY =
  'h-[50px] cursor-pointer rounded-[10px] border-0 font-display text-[14px] font-bold tracking-[0.06em] uppercase transition-[filter,transform] active:scale-[0.99] disabled:cursor-wait disabled:opacity-70 motion-reduce:transition-none motion-reduce:active:scale-100';

/** A notice that sits on top of whichever bar is showing — where the thumb is. */
export function BarNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-t border-[#efd9a8] bg-warn-bg px-4 py-2.5 text-[13px] leading-[1.45] text-[#5c3f0f]"
    >
      <span className="mx-auto flex w-full max-w-[560px] items-start gap-2">
        <IconWarning size={16} className="mt-px shrink-0" />
        <span className="min-w-0">{children}</span>
      </span>
    </div>
  );
}

/** The green Finish workout, on whichever bar is showing. */
export function FinishButton({
  busy,
  onFinish,
  className,
}: {
  busy: boolean;
  onFinish: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(PRIMARY, FOCUS, 'bg-ok text-white hover:brightness-110', className)}
      disabled={busy}
      onClick={onFinish}
    >
      {busy ? 'Finishing…' : 'Finish workout'}
    </button>
  );
}

/**
 * ‹ Prev and Next exercise ›, or ‹ Prev and Finish workout on the last
 * exercise. With every set ticked on an earlier exercise, Finish takes the
 * wide slot and Prev / Next shrink to arrows, so the member can still move
 * between exercises.
 */
export function StepBar({
  isFirst,
  isLast,
  canFinish,
  busy,
  onPrev,
  onNext,
  onFinish,
}: {
  isFirst: boolean;
  isLast: boolean;
  /** `offersFinish`: true on the last exercise, and anywhere once every set is ticked. */
  canFinish: boolean;
  busy: boolean;
  onPrev: () => void;
  onNext: () => void;
  onFinish: () => void;
}) {
  if (canFinish && !isLast) {
    return (
      <div className="shrink-0 border-t border-border bg-card">
        <div className={cn(BAR_INNER, 'grid grid-cols-[50px_50px_minmax(0,1fr)] gap-2')}>
          <button
            type="button"
            aria-label="Previous exercise"
            className={cn(GHOST, 'text-[18px]')}
            disabled={isFirst}
            onClick={onPrev}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Next exercise"
            className={cn(GHOST, 'text-[18px]')}
            onClick={onNext}
          >
            ›
          </button>
          <FinishButton busy={busy} onFinish={onFinish} />
        </div>
      </div>
    );
  }
  return (
    <div className="shrink-0 border-t border-border bg-card">
      <div className={cn(BAR_INNER, 'grid grid-cols-[110px_minmax(0,1fr)] gap-2')}>
        <button type="button" className={GHOST} disabled={isFirst} onClick={onPrev}>
          ‹ Prev
        </button>
        {isLast ? (
          <FinishButton busy={busy} onFinish={onFinish} />
        ) : (
          <button
            type="button"
            className={cn(
              PRIMARY,
              FOCUS,
              'bg-primary text-primary-foreground hover:bg-[var(--p-primary-hover)]',
            )}
            onClick={onNext}
          >
            Next exercise ›
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * End → "Finish this workout?" when a set is ticked, "Discard this workout?"
 * when none is (spec §5). Focus lands on Keep going; Escape is Keep going.
 *
 * Also what a workout left open (`leftOpen`) opens on, with `leftOpen` set to
 * its "Started Wed, Sep 30" so the question says why it is being asked.
 */
export function EndBar({
  mode,
  setsDone,
  leftOpen = null,
  busy,
  onCancel,
  onConfirm,
}: {
  mode: 'finish' | 'discard';
  setsDone: number;
  /** "Started Wed, Sep 30" for a workout left open; null otherwise. */
  leftOpen?: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keep.current?.focus();
  }, [mode]);

  return (
    <div
      role="alertdialog"
      aria-labelledby="wk-end-h"
      aria-describedby="wk-end-d"
      className="shrink-0 border-t border-border bg-card"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onCancel();
      }}
    >
      <div className={cn(BAR_INNER, 'flex flex-col gap-3 pt-3.5')}>
        <div className="flex flex-col gap-0.5">
          <h2 id="wk-end-h" className="m-0 font-display text-[17px] font-bold">
            {mode === 'finish' ? 'Finish this workout?' : 'Discard this workout?'}
          </h2>
          <p id="wk-end-d" className="m-0 text-[13.5px] leading-[1.45] text-ink-2">
            {leftOpen === null ? null : `You did not finish this one. ${leftOpen}. `}
            {mode === 'finish'
              ? `${setsDone} ${setsDone === 1 ? 'set is' : 'sets are'} saved. You can say how it felt next.`
              : 'Nothing is ticked yet, so there is nothing to save.'}
          </p>
        </div>
        <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-2">
          <button ref={keep} type="button" className={GHOST} disabled={busy} onClick={onCancel}>
            Keep going
          </button>
          <button
            type="button"
            className={cn(
              PRIMARY,
              FOCUS,
              mode === 'finish'
                ? 'bg-ok text-white hover:brightness-110'
                : 'bg-danger text-white hover:brightness-110',
            )}
            disabled={busy}
            onClick={onConfirm}
          >
            {mode === 'finish'
              ? busy
                ? 'Finishing…'
                : 'Finish workout'
              : busy
                ? 'Discarding…'
                : 'Discard workout'}
          </button>
        </div>
      </div>
    </div>
  );
}
