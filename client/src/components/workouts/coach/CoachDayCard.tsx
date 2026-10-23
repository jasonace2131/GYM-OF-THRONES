'use client';

import type { CoachDayView } from '@/lib/workouts/coachPlan';
import { cn } from '@/lib/utils';
import { HowToPanel, type GuideState } from '../plan/HowToPanel';
import { ExerciseRow } from '../plan/ExerciseRow';
import { StartDayButton } from '../session/StartDayButton';
import type { SessionStarter } from '../session/useSessionStarter';
import { Chip } from '../ui';

const noop = (): void => undefined;

/**
 * One day of the coach's plan, in the planner's day-card style (DayCard):
 * DAY · WEEKDAY kicker, the focus as title, the exercises with How to, and
 * "Start this day". Read-only — no Swap, no Adjust, no edits: it is the
 * coach's plan.
 */
export function CoachDayCard({
  day,
  highlighted,
  openIndex,
  guideFor,
  starter,
  onHow,
  onRetryGuide,
}: {
  day: CoachDayView;
  highlighted: boolean;
  openIndex: number | null;
  guideFor: (name: string) => GuideState | null;
  starter: SessionStarter;
  onHow: (index: number) => void;
  onRetryGuide: (name: string) => void;
}) {
  return (
    <article
      id={day.anchor}
      aria-labelledby={`${day.anchor}-h`}
      tabIndex={-1}
      className={cn(
        'flex scroll-mt-4 flex-col overflow-hidden rounded-[14px] border bg-card shadow-[var(--p-shadow)] transition-[box-shadow] duration-500 outline-none motion-reduce:transition-none',
        highlighted ? 'border-gold shadow-[0_0_0_4px_rgba(201,146,42,0.25)]' : 'border-border',
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(26,26,26,0.08)] bg-[#fbfaf8] px-4 py-4 @2xl:px-[22px] @2xl:py-[18px]">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] font-bold tracking-[0.14em] text-ink-3 uppercase">
            {day.kicker}
          </span>
          <h3
            id={`${day.anchor}-h`}
            className="m-0 font-display text-[20px] font-bold @2xl:text-[22px]"
          >
            {day.title}
          </h3>
        </div>
        <Chip>{day.count}</Chip>
      </header>

      <ol className="m-0 list-none p-0">
        {day.exercises.map((exercise, i) => {
          const open = openIndex === i;
          const guide = open ? guideFor(exercise.name) : null;
          return (
            <li
              key={`${i}-${exercise.name}`}
              className="border-b border-[rgba(26,26,26,0.06)] last:border-b-0"
            >
              <ExerciseRow
                index={i}
                // The coach sets no rest; the session will rest 90 s, but the plan does not say so.
                exercise={{ ...exercise, restSeconds: null }}
                swapped={false}
                howOpen={open}
                swapOpen={false}
                toolbelt="howOnly"
                busy={false}
                onHow={() => onHow(i)}
                onSwap={noop}
                onUndoSwap={noop}
              />
              {open && guide !== null ? (
                <HowToPanel
                  state={guide}
                  exerciseName={exercise.name}
                  onRetry={() => onRetryGuide(exercise.name)}
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="border-t border-[rgba(26,26,26,0.06)] px-4 py-3.5 @2xl:px-[22px]">
        <StartDayButton starter={starter} body={day.start} dayName={day.title} />
      </div>
    </article>
  );
}
