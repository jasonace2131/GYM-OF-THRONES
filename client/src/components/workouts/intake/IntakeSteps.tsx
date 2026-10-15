import { STEP_LABELS, canGoTo, type IntakeState, type IntakeStep } from '@/lib/workouts/intake';
import { cn } from '@/lib/utils';

/**
 * The four step pills (desktop) and the four-segment bar (phone). A pill is
 * a real button back to any completed step; a future step is not a button.
 */
export function IntakeSteps({
  state,
  onGoTo,
}: {
  state: IntakeState;
  onGoTo: (step: IntakeStep) => void;
}) {
  return (
    <>
      <div aria-hidden className="grid grid-cols-4 gap-1 @2xl:hidden">
        {STEP_LABELS.map((label, i) => {
          const n = (i + 1) as IntakeStep;
          return (
            <span
              key={label}
              className={cn(
                'h-1 rounded-sm',
                n < state.step ? 'bg-ok' : n === state.step ? 'bg-gold' : 'bg-paper-3',
              )}
            />
          );
        })}
      </div>
      <ol aria-label="Steps" className="m-0 hidden list-none grid-cols-4 gap-2 p-0 @2xl:grid">
        {STEP_LABELS.map((label, i) => {
          const n = (i + 1) as IntakeStep;
          const kind = n === state.step ? 'current' : n < state.step ? 'done' : 'next';
          const reachable = canGoTo(state, n);
          const inner = (
            <>
              <span
                className={cn(
                  'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[12.5px] font-bold',
                  kind === 'current'
                    ? 'bg-gold text-night'
                    : kind === 'done'
                      ? 'bg-ok text-white'
                      : 'bg-paper-3 text-ink-3',
                )}
                aria-hidden
              >
                {n}
              </span>
              <span>{label}</span>
            </>
          );
          const className = cn(
            'flex h-12 w-full items-center gap-2.5 rounded-[10px] border-[1.5px] px-3.5 text-left text-[14px]',
            kind === 'current'
              ? 'border-gold bg-[#fffaf0] font-semibold text-foreground'
              : kind === 'done'
                ? 'border-[rgba(26,26,26,0.12)] bg-card font-semibold text-foreground'
                : 'border-[rgba(26,26,26,0.12)] bg-card font-medium text-ink-3',
          );
          return (
            <li key={label}>
              {reachable ? (
                <button
                  type="button"
                  aria-current={kind === 'current' ? 'step' : undefined}
                  onClick={() => onGoTo(n)}
                  className={cn(
                    className,
                    'cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold',
                  )}
                >
                  {inner}
                </button>
              ) : (
                <span className={className} aria-disabled>
                  {inner}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
