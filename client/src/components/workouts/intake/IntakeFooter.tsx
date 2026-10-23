import type { WorkoutAiQuotaView } from '@got/shared';
import { nextLabel, type IntakeStep } from '@/lib/workouts/intake';
import { canSpend, generateNote } from '@/lib/workouts/quota';
import { IconSparkles } from '../icons';
import { Button } from '../ui';

/**
 * Back · Step n of 4 · Next / Generate. Inside the card on desktop; on a
 * phone it is a sticky bar pinned directly on top of the tab bar, so the way
 * forward is always under the thumb. `data-sticky-bar` tells portal.css to end
 * the page flush on the tab bar (see `.p-content:has([data-sticky-bar])`) —
 * any padding there left a gap under the bar at the end of the scroll. Its
 * phone background is the page's, not a white band.
 */
export function IntakeFooter({
  step,
  consent,
  quota,
  busy,
  onBack,
  onNext,
  onGenerate,
}: {
  step: IntakeStep;
  consent: boolean;
  quota: WorkoutAiQuotaView | null;
  busy: boolean;
  onBack: () => void;
  onNext: () => void;
  onGenerate: () => void;
}) {
  const next = nextLabel(step);
  const spendable = quota === null || canSpend(quota);
  const canGenerate = consent && spendable && !busy;

  return (
    <div
      data-sticky-bar
      className="border-t border-[rgba(26,26,26,0.08)] bg-card px-4 py-3 max-[900px]:sticky max-[900px]:bottom-[calc(var(--p-tabbar-h)+env(safe-area-inset-bottom,0px))] max-[900px]:z-30 @max-2xl:max-[900px]:bg-background max-[900px]:-mx-4 max-[900px]:shadow-[0_-8px_24px_rgba(26,26,26,0.06)] @2xl:mx-0 @2xl:px-0 @2xl:pt-[18px] @2xl:pb-0 @2xl:shadow-none">
      <div className="flex items-center justify-between gap-3">
        <div>
          {step > 1 ? (
            // Under 380px the word goes to screen readers only and the button
            // is a 44px arrow, so "Generate my plan" never pushes it off screen.
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="min-w-11 px-[18px] max-[379px]:px-0"
            >
              <span aria-hidden>‹</span>
              <span className="max-[379px]:sr-only">Back</span>
            </Button>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="hidden text-[13px] text-ink-3 @md:inline">Step {step} of 4</span>
          {next !== null ? (
            <Button variant="dark" size="md" className="max-[379px]:px-4" onClick={onNext}>
              {next}
            </Button>
          ) : (
            <span className="flex flex-col items-end gap-1">
              <Button
                variant={canGenerate ? 'gold' : 'muted'}
                size="md"
                className="max-[379px]:px-4"
                disabled={!canGenerate}
                aria-describedby={consent ? undefined : 'wk-consent-hint'}
                onClick={onGenerate}
              >
                <IconSparkles />
                {busy ? 'Starting…' : 'Generate my plan'}
              </Button>
              {consent ? null : (
                <span id="wk-consent-hint" className="sr-only">
                  Tick the consent box first.
                </span>
              )}
            </span>
          )}
        </div>
      </div>
      {step === 4 && quota !== null ? (
        <p className="m-0 mt-1.5 text-center text-[12.5px] text-ink-3 @2xl:text-right">
          {generateNote(quota)}
        </p>
      ) : null}
    </div>
  );
}
