import type { ExerciseGuideView } from '@got/shared';
import { cn } from '@/lib/utils';
import { IconCheck, IconWarning } from '../icons';
import { Bone, Notice, PlainButton } from '../ui';

export type GuideState =
  | { kind: 'loading' }
  | { kind: 'ready'; guide: ExerciseGuideView }
  | { kind: 'error'; message: string };

/**
 * The blue "How to do it" panel — a cached, shared answer that costs nothing.
 * Indented under a plan row by default; the session card passes `m-0`.
 */
export function HowToPanel({
  state,
  onRetry,
  className,
}: {
  state: GuideState;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mx-4 mb-4 grid grid-cols-1 gap-4 rounded-xl border-[1.5px] border-[#c9d7f2] bg-[#f4f7fd] px-4 py-4 @2xl:mr-[22px] @2xl:ml-[66px] @2xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] @2xl:gap-5 @2xl:px-[18px]',
        className,
      )}
      role="region"
      aria-label="How to do it"
      aria-busy={state.kind === 'loading' || undefined}
    >
      {state.kind === 'error' ? (
        <div className="@2xl:col-span-2">
          <Notice tone="warn" icon={<IconWarning />} role="alert">
            <span className="flex flex-wrap items-center justify-between gap-2">
              {state.message}
              <PlainButton tone="ghost" className="h-9" onClick={onRetry}>
                Try again
              </PlainButton>
            </span>
          </Notice>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2.5">
            <span className="text-[14px] font-bold text-info">How to do it</span>
            {state.kind === 'loading' ? (
              <div className="flex flex-col gap-2.5">
                <Bone className="h-3 w-[90%]" />
                <Bone className="h-3 w-[80%]" />
                <Bone className="h-3 w-[70%]" />
              </div>
            ) : (
              <ol className="m-0 flex flex-col gap-1.5 pl-[18px] text-[13.5px] leading-[1.5] text-[color:var(--p-ink)]">
                {state.guide.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            )}
          </div>
          <div className="flex flex-col gap-2 text-[13px] leading-[1.45] text-[color:var(--p-ink)]">
            {state.kind === 'loading' ? (
              <>
                <Bone className="h-3 w-[85%]" />
                <Bone className="h-3 w-[60%]" />
                <Bone className="h-3 w-[65%]" />
              </>
            ) : (
              <>
                <div>
                  <strong>Watch out:</strong> {state.guide.mistake}
                </div>
                <div>
                  <strong>Easier:</strong> {state.guide.easier}
                </div>
                <div>
                  <strong>Harder:</strong> {state.guide.harder}
                </div>
              </>
            )}
            <span className="mt-1 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ok">
              <IconCheck size={14} />
              Free — shared answer, no AI action used
            </span>
          </div>
        </>
      )}
    </div>
  );
}
