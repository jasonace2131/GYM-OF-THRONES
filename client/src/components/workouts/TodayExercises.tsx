import Link from 'next/link';
import type { TodayExerciseRow } from '@/lib/workouts/today';
import { KickerHeading, Panel } from './ui';

/**
 * TODAY'S EXERCISES on the hub — read-only rows; the toolbelt lives on the
 * plan page. Number · name / muscles · dose · rest on desktop; on a phone the
 * dose and rest collapse into the second line. A coach's plan records no
 * muscles and no rest, so neither is shown for it.
 */
export function TodayExercises({
  exercises,
  planHref,
}: {
  exercises: readonly TodayExerciseRow[];
  planHref: string;
}) {
  return (
    <Panel aria-labelledby="wk-ex-h" className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[rgba(26,26,26,0.08)] px-4 py-3.5 @md:px-[22px] @md:py-[18px]">
        <KickerHeading id="wk-ex-h">Today&apos;s exercises</KickerHeading>
        <Link
          href={planHref}
          className="text-[13px] font-semibold text-gold-deep no-underline hover:underline"
        >
          Open the full plan →
        </Link>
      </div>
      <ol className="m-0 list-none p-0">
        {exercises.map((exercise, i) => (
          <li
            key={`${i}-${exercise.name}`}
            className="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-3 border-b border-[rgba(26,26,26,0.06)] px-4 py-3 last:border-b-0 @md:grid-cols-[32px_minmax(0,1fr)_120px_80px] @md:gap-3.5 @md:px-[22px] @md:py-3.5"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-paper-3 text-[12.5px] font-bold text-[color:var(--p-ink)]">
              {i + 1}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[15px] font-semibold">{exercise.name}</span>
              <span className="text-[12.5px] text-ink-3">
                <span className={exercise.muscles === null ? undefined : '@md:hidden'}>
                  {exercise.line}
                </span>
                {exercise.muscles === null ? null : (
                  <span className="hidden @md:inline">{exercise.muscles}</span>
                )}
              </span>
            </span>
            <span className="hidden text-right font-display text-[15px] font-bold @md:block">
              {exercise.dose}
            </span>
            <span className="hidden text-right text-[12.5px] text-ink-3 @md:block">
              {exercise.rest ?? ''}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
