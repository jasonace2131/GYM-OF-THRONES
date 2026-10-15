import type { WorkoutAiQuotaView } from '@got/shared';
import { nextLabel, type IntakeStep } from '@/lib/workouts/intake';
import { canSpend, generateNote } from '@/lib/workouts/quota';
import { IconSparkles } from '../icons';
import { Button } from '../ui';

/**
 * Back · Step n of 4 · Next / Generate. Inside the card on desktop; on a
 * phone it is a sticky bar just above the tab bar, so the way forward is
 * always under the thumb.
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
    <div className="border-t border-[rgba(26,26,26,0.08)] bg-card px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))] max-[900px]:sticky max-[900px]:bottom-[58px] max-[900px]:z-30 max-[900px]:-mx-4 max-[900px]:shadow-[0_-8px_24px_rgba(26,26,26,0.06)] @2xl:mx-0 @2xl:px-0 @2xl:pt-[18px] @2xl:pb-0 @2xl:shadow-none">
      <div className="flex items-center justify-between gap-3">
        <div>
          {step > 1 ? (
            <Button variant="ghost" size="sm" onClick={onBack} className="px-[18px]">
              Back
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-3.5">
          <span className="hidden text-[13px] text-ink-3 @md:inline">Step {step} of 4</span>
          {next !== null ? (
            <Button variant="dark" size="md" onClick={onNext}>
              {next}
            </Button>
          ) : (
            <span className="flex flex-col items-end gap-1">
              <Button
                variant={canGenerate ? 'gold' : 'muted'}
                size="md"
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
