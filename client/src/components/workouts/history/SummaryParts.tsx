'use client';

import type { WorkoutFeeling, WorkoutSessionSummary } from '@got/shared';
import { FEELING_OPTIONS, bestLine, exerciseLine, statTiles } from '@/lib/workouts/history';
import { cn } from '@/lib/utils';
import { IconTrophy } from '../icons';
import { KickerHeading, RadioPill } from '../ui';

/**
 * The pieces of a finished workout (PhoneFinish.dc.html): the four tiles,
 * a card per new best, "How did it feel?", and WHAT YOU DID. The finish
 * screen and the plain history entry both build from these.
 */

/** SETS DONE · EXERCISES · WEIGHT MOVED · NEW BEST — 2 across on a phone. */
export function StatTiles({
  summary,
  className,
}: {
  summary: WorkoutSessionSummary;
  className?: string;
}) {
  return (
    <dl className={cn('m-0 grid grid-cols-2 gap-2.5', className)}>
      {statTiles(summary).map((tile) => (
        <div
          key={tile.label}
          className={cn(
            'flex flex-col gap-0.5 rounded-xl p-3.5',
            tile.highlight
              ? 'border-[1.5px] border-gold bg-[#fffaf0]'
              : 'border border-border bg-card',
          )}
        >
          {/* dt first for a valid <dl>; the number still reads first. */}
          <dt
            className={cn(
              'order-2 text-[11px] font-bold tracking-[0.12em] uppercase',
              tile.highlight ? 'text-gold-deep' : 'text-ink-3',
            )}
          >
            {tile.label}
          </dt>
          <dd
            className={cn(
              'order-1 m-0 font-display text-[26px] font-extrabold tabular-nums',
              tile.highlight && 'text-gold-deep',
            )}
          >
            {tile.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One card per new best: the exercise, "14 kg × 10 — up from 12 kg". */
export function NewBests({ summary }: { summary: WorkoutSessionSummary }) {
  if (summary.bests.length === 0) return null;
  return (
    <>
      {summary.bests.map((best, i) => (
        <section
          key={`${i}-${best.exerciseName}`}
          aria-labelledby={`wk-best-${i}-h`}
          className="flex items-center gap-3 rounded-[14px] border-[1.5px] border-gold bg-card px-4 py-3.5"
        >
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warn-bg text-gold-deep"
          >
            <IconTrophy />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id={`wk-best-${i}-h`} className="m-0 text-[14.5px] font-bold">
              <span className="sr-only">New best: </span>
              {best.exerciseName}
            </h2>
            <span className="text-[13px] text-ink-2">{bestLine(best)}</span>
          </div>
        </section>
      ))}
    </>
  );
}

/** "How did it feel? · optional" — Easy / Just right / Hard. */
export function FeelingPicker({
  value,
  busy,
  onChange,
}: {
  value: WorkoutFeeling | null;
  busy: boolean;
  onChange: (feeling: WorkoutFeeling) => void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2.5 rounded-[14px] border border-border bg-card px-4 py-3.5">
      <legend className="px-1.5 text-[13.5px] font-semibold">
        How did it feel? <span className="font-normal text-ink-3">· optional</span>
      </legend>
      <div role="radiogroup" aria-label="How did it feel" className="grid grid-cols-3 gap-2">
        {FEELING_OPTIONS.map((option) => (
          <RadioPill
            key={option.value}
            checked={value === option.value}
            disabled={busy}
            onClick={() => {
              if (value !== option.value) onChange(option.value);
            }}
            className="px-2 text-[13.5px] disabled:cursor-wait"
          >
            {option.label}
          </RadioPill>
        ))}
      </div>
    </fieldset>
  );
}

/** WHAT YOU DID: each exercise and its line. */
export function WhatYouDid({ summary }: { summary: WorkoutSessionSummary }) {
  return (
    <section
      aria-labelledby="wk-did-h"
      className="overflow-hidden rounded-[14px] border border-border bg-card"
    >
      <KickerHeading id="wk-did-h" className="px-4 pt-3 pb-1.5 text-[11px]">
        What you did
      </KickerHeading>
      <ul className="m-0 list-none p-0">
        {summary.perExercise.map((exercise, i) => (
          <li
            key={`${i}-${exercise.name}`}
            className="flex justify-between gap-2.5 border-t border-[rgba(26,26,26,0.06)] px-4 py-2 text-[13.5px]"
          >
            <span className="min-w-0 font-semibold">{exercise.name}</span>
            <span
              className={cn(
                // May wrap: ~190px of unbreakable text squeezed the name to
                // a word per line on a phone.
                'max-w-[55%] text-right',
                exercise.setsDone === 0 ? 'text-ink-3' : 'text-ink-2',
              )}
            >
              {exerciseLine(exercise)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
