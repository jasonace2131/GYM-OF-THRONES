'use client';

import { SESSION_LIMITS } from '@got/shared';
import type { ExerciseCardCopy, SetRow } from '@/lib/workouts/sessionState';
import { IconInfo, IconLastTime, IconPlus } from '../icons';
import { HowToPanel, type GuideState } from '../plan/HowToPanel';
import { SetTable, type SetTableHandlers } from './SetTable';

/**
 * The exercise on screen (PhoneSession.dc.html): kicker, name, How to, the
 * muscles when the plan records them, the target and "Last time" chips, the
 * set rows, and Add a set. The card is its own size container, so the rows
 * can tighten on a 360px phone without the page knowing.
 */
export function ExerciseCard({
  copy,
  rows,
  howOpen,
  guide,
  onHow,
  onRetryGuide,
  onAddSet,
  ...handlers
}: {
  copy: ExerciseCardCopy;
  rows: readonly SetRow[];
  howOpen: boolean;
  guide: GuideState | null;
  onHow: () => void;
  onRetryGuide: () => void;
  onAddSet: () => void;
} & SetTableHandlers) {
  const full = rows.length >= SESSION_LIMITS.setsPerExerciseMax;
  return (
    <section
      aria-labelledby="wk-session-ex-h"
      className="@container flex flex-col gap-3 rounded-[14px] border border-border bg-card p-4 shadow-[var(--p-shadow)]"
    >
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-bold tracking-[0.14em] text-ink-3">{copy.kicker}</span>
        <div className="flex items-start justify-between gap-2.5">
          <h2
            id="wk-session-ex-h"
            className="m-0 font-display text-[24px] leading-[1.1] font-extrabold"
          >
            {copy.name}
          </h2>
          <button
            type="button"
            aria-expanded={howOpen}
            aria-label={`How to do ${copy.name}`}
            onClick={onHow}
            className="relative inline-flex h-9 shrink-0 cursor-pointer items-center gap-[5px] rounded-lg border-[1.5px] border-[#9fb6e6] bg-[#f4f7fd] px-[11px] text-[12.5px] font-semibold text-info transition-colors after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] hover:bg-info-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold aria-expanded:bg-info-bg motion-reduce:transition-none"
          >
            <IconInfo size={14} />
            How to
          </button>
        </div>
        {copy.muscles === null ? null : (
          <span className="text-[13px] text-ink-3">{copy.muscles}</span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <span className="inline-flex h-7 items-center rounded-full bg-[#f2f0ec] px-[11px] text-[12.5px] font-semibold text-[color:var(--p-ink)]">
          {copy.target}
        </span>
        {copy.last === null ? null : (
          <span className="inline-flex h-7 items-center gap-[5px] rounded-full bg-info-bg px-[11px] text-[12.5px] font-semibold text-info">
            <IconLastTime />
            {copy.last}
          </span>
        )}
      </div>

      {howOpen && guide !== null ? (
        <HowToPanel state={guide} onRetry={onRetryGuide} className="m-0 @2xl:m-0" />
      ) : null}

      <SetTable rows={rows} {...handlers} />

      <button
        type="button"
        onClick={onAddSet}
        disabled={full}
        className="relative inline-flex h-10 cursor-pointer items-center gap-1.5 self-start rounded-lg border-0 bg-transparent px-1 text-[13.5px] font-semibold text-gold-deep after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-[''] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
      >
        <IconPlus size={16} strokeWidth={2.2} />
        {full ? `${SESSION_LIMITS.setsPerExerciseMax} sets is the most` : 'Add a set'}
      </button>
    </section>
  );
}
