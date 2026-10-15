import type { WorkoutDraftView } from '@got/shared';
import { progressPercent, progressSteps, statusLine } from '@/lib/workouts/draftProgress';
import { cn } from '@/lib/utils';
import { IconCheck, IconSparkles, IconSpinner } from '../icons';
import { Panel, PlainButton } from '../ui';

/**
 * "Building your plan…" — the steps read off the draft, the thin gold bar,
 * and Cancel. The status line is `role="status"` so a screen reader hears
 * each day land; the spinner stops under reduced motion.
 */
export function ProgressCard({
  draft,
  cancelling,
  onCancel,
}: {
  draft: WorkoutDraftView;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const steps = progressSteps(draft);
  const percent = progressPercent(steps);
  return (
    <Panel
      aria-labelledby="wk-gen-h"
      className="flex flex-col gap-4 px-4 py-4 @2xl:gap-[18px] @2xl:px-[26px] @2xl:py-[22px]"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <span
            className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full bg-gold text-night"
            aria-hidden
          >
            <IconSparkles size={22} />
          </span>
          <div className="flex min-w-0 flex-col gap-[3px]">
            <h2 id="wk-gen-h" className="m-0 font-display text-[20px] font-bold @2xl:text-[22px]">
              {draft.status === 'READY' ? 'Your plan is ready' : 'Building your plan…'}
            </h2>
            <p role="status" className="m-0 text-[14px] text-ink-2">
              {statusLine(draft)}
            </p>
          </div>
        </div>
        {draft.status === 'RUNNING' ? (
          <PlainButton tone="ghost" onClick={onCancel} disabled={cancelling}>
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </PlainButton>
        ) : null}
      </div>
      <ol className="m-0 grid list-none grid-cols-1 gap-2 p-0 @md:grid-cols-2 @2xl:grid-cols-5 @2xl:gap-2.5">
        {steps.map((step) => (
          <li
            key={step.key}
            className={cn(
              'flex items-center gap-2.5 rounded-[10px] px-3.5 py-3 text-[13.5px] font-semibold',
              step.state === 'done'
                ? 'bg-ok-bg text-[#1a4d2e]'
                : step.state === 'active'
                  ? 'border-[1.5px] border-gold bg-warn-bg text-[#5c3f0f]'
                  : 'bg-paper-3 text-ink-3',
            )}
          >
            {step.state === 'done' ? (
              <IconCheck size={18} className="shrink-0" />
            ) : step.state === 'active' ? (
              <IconSpinner size={18} className="shrink-0 motion-safe:animate-spin" />
            ) : (
              <span
                aria-hidden
                className="h-[18px] w-[18px] shrink-0 rounded-full border-2 border-[#c7c3bc]"
              />
            )}
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{step.label}</span>
              {step.detail === null ? null : (
                <span className="text-[12.5px] font-medium">{step.detail}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Plan progress"
        className="h-1.5 overflow-hidden rounded-[3px] bg-paper-3"
      >
        <div
          className="h-1.5 rounded-[3px] bg-gold transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
    </Panel>
  );
}
