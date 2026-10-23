import type { ReactNode } from 'react';
import type { MemberPlanDay, SwapAlternative, WorkoutAdjustPreset } from '@got/shared';
import { aboutMinutes, dayKicker, exerciseCount } from '@/lib/workouts/planView';
import { cn } from '@/lib/utils';
import { Chip } from '../ui';
import { AdjustBar } from './AdjustBar';
import { AdjustedNotice } from './AdjustedNotice';
import { ExerciseRow } from './ExerciseRow';
import { HowToPanel, type GuideState } from './HowToPanel';
import { SwapPanel, type SwapState } from './SwapPanel';

export interface DayCardProps {
  index: number;
  day: MemberPlanDay;
  highlighted: boolean;
  toolbelt: 'full' | 'howOnly';
  busy: boolean;
  /** Which row has a panel open, if any, and which kind. */
  open: { kind: 'how' | 'swap'; index: number } | null;
  /** The swap panel is inline on desktop; on a phone the sheet renders it instead. */
  inlineSwap: boolean;
  swapState: SwapState | null;
  guideFor: (name: string) => GuideState | null;
  swappedIndex: number | null;
  adjusted: string | null;
  activePreset: WorkoutAdjustPreset | null;
  adjustDisabled: string | null;
  showAdjust: boolean;
  onHow: (index: number) => void;
  onSwap: (index: number) => void;
  onUse: (alternative: SwapAlternative) => void;
  onRetrySwap: () => void;
  onRetryGuide: (name: string) => void;
  onUndoSwap: () => void;
  onPreset: (preset: WorkoutAdjustPreset) => void;
  onRequest: (request: string) => void;
  onKeep: () => void;
  onUndoAdjust: () => void;
  /** "Start this day" (feat/workout-sessions) — a saved plan only. */
  startSlot?: ReactNode;
}

/** One day of the plan: header, warm-up, rows with their panels, cool-down, Adjust. */
export function DayCard(props: DayCardProps) {
  const { day, index } = props;
  return (
    <article
      id={`day-${day.weekday}`}
      aria-labelledby={`wk-day-h-${day.weekday}`}
      tabIndex={-1}
      className={cn(
        'flex scroll-mt-4 flex-col overflow-hidden rounded-[14px] border bg-card shadow-[var(--p-shadow)] transition-[box-shadow] duration-500 outline-none',
        props.highlighted
          ? 'border-gold shadow-[0_0_0_4px_rgba(201,146,42,0.25)]'
          : 'border-border',
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(26,26,26,0.08)] bg-[#fbfaf8] px-4 py-4 @2xl:px-[22px] @2xl:py-[18px]">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-bold tracking-[0.14em] text-ink-3 uppercase">
            {dayKicker(index, day.weekday)}
          </span>
          <h3
            id={`wk-day-h-${day.weekday}`}
            className="m-0 font-display text-[20px] font-bold @2xl:text-[22px]"
          >
            {day.title}
          </h3>
        </div>
        <div className="flex gap-2">
          <Chip>{aboutMinutes(day.minutes)}</Chip>
          <Chip>{exerciseCount(day.exercises.length)}</Chip>
        </div>
      </header>

      <div className="flex items-baseline gap-3.5 border-b border-[rgba(26,26,26,0.06)] px-4 py-3 text-[13.5px] text-[color:var(--p-ink)] @2xl:px-[22px]">
        <span className="w-[72px] shrink-0 text-[11px] font-bold tracking-[0.12em] text-ink-3 uppercase @2xl:w-20">
          Warm-up
        </span>
        <span>{day.warmUp}</span>
      </div>

      {props.adjusted === null ? null : (
        <AdjustedNotice
          summary={props.adjusted}
          busy={props.busy}
          onKeep={props.onKeep}
          onUndo={props.onUndoAdjust}
        />
      )}

      <ol className="m-0 list-none p-0">
        {day.exercises.map((exercise, i) => {
          const howOpen = props.open?.kind === 'how' && props.open.index === i;
          const swapOpen = props.open?.kind === 'swap' && props.open.index === i;
          const guide = howOpen ? props.guideFor(exercise.name) : null;
          return (
            <li
              key={`${i}-${exercise.name}`}
              className="border-b border-[rgba(26,26,26,0.06)] last:border-b-0"
            >
              <ExerciseRow
                index={i}
                exercise={exercise}
                swapped={props.swappedIndex === i}
                howOpen={howOpen}
                swapOpen={swapOpen}
                toolbelt={props.toolbelt}
                busy={props.busy}
                onHow={() => props.onHow(i)}
                onSwap={() => props.onSwap(i)}
                onUndoSwap={props.onUndoSwap}
              />
              {swapOpen && props.inlineSwap && props.swapState !== null ? (
                <SwapPanel
                  original={exercise.name}
                  state={props.swapState}
                  busy={props.busy}
                  onUse={props.onUse}
                  onRetry={props.onRetrySwap}
                />
              ) : null}
              {howOpen && guide !== null ? (
                <HowToPanel
                  state={guide}
                  exerciseName={exercise.name}
                  onRetry={() => props.onRetryGuide(exercise.name)}
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="flex items-baseline gap-3.5 border-b border-[rgba(26,26,26,0.06)] px-4 py-3 text-[13.5px] text-[color:var(--p-ink)] @2xl:px-[22px]">
        <span className="w-[72px] shrink-0 text-[11px] font-bold tracking-[0.12em] text-ink-3 uppercase @2xl:w-20">
          Cool-down
        </span>
        <span>{day.coolDown}</span>
      </div>

      {props.startSlot === undefined || props.startSlot === null ? null : (
        <div className="border-b border-[rgba(26,26,26,0.06)] px-4 py-3.5 @2xl:px-[22px]">
          {props.startSlot}
        </div>
      )}

      {props.showAdjust ? (
        <AdjustBar
          weekday={day.weekday}
          activePreset={props.activePreset}
          busy={props.busy}
          disabled={props.adjustDisabled}
          onPreset={props.onPreset}
          onRequest={props.onRequest}
        />
      ) : null}
    </article>
  );
}
