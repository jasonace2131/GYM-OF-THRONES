import type { SwapAlternative } from '@got/shared';
import { IconSparkle, IconWarning } from '../icons';
import { Bone, Button, Notice, PlainButton } from '../ui';

export type SwapState =
  | { kind: 'loading' }
  | { kind: 'ready'; alternatives: SwapAlternative[] }
  | { kind: 'error'; message: string };

/** Desktop: the inline gold card with three alternatives under the row. */
export function SwapPanel({
  original,
  state,
  busy,
  onUse,
  onRetry,
}: {
  original: string;
  state: SwapState;
  busy: boolean;
  onUse: (alternative: SwapAlternative) => void;
  onRetry: () => void;
}) {
  return (
    <div
      className="mx-4 mb-4 flex flex-col gap-3 rounded-xl border-[1.5px] border-[rgba(201,146,42,0.5)] bg-[#fffaf0] px-4 py-4 @2xl:mr-[22px] @2xl:ml-[66px] @2xl:px-[18px]"
      role="region"
      aria-label={`Swap ${original}`}
      aria-busy={state.kind === 'loading' || undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-[14px] font-semibold">
          <IconSparkle size={16} className="text-gold-deep" />
          Swap {original} for…
        </span>
        <span className="text-[12.5px] text-ink-3">
          Same muscles · your level · uses 1 AI action
        </span>
      </div>
      <SwapAlternatives state={state} busy={busy} onUse={onUse} onRetry={onRetry} layout="grid" />
    </div>
  );
}

/** The three cards (or their skeletons, or the error). Shared with the sheet. */
export function SwapAlternatives({
  state,
  busy,
  onUse,
  onRetry,
  layout,
}: {
  state: SwapState;
  busy: boolean;
  onUse: (alternative: SwapAlternative) => void;
  onRetry: () => void;
  layout: 'grid' | 'list';
}) {
  if (state.kind === 'error') {
    return (
      <Notice tone="warn" icon={<IconWarning />} role="alert">
        <span className="flex flex-wrap items-center justify-between gap-2">
          {state.message}
          <PlainButton tone="ghost" className="h-9" onClick={onRetry}>
            Try again
          </PlainButton>
        </span>
      </Notice>
    );
  }

  if (state.kind === 'loading') {
    return (
      <div
        className={
          layout === 'grid' ? 'grid grid-cols-1 gap-2.5 @2xl:grid-cols-3' : 'flex flex-col gap-2.5'
        }
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-[10px] border border-border bg-card p-3.5"
            aria-hidden
          >
            <Bone className="h-3.5 w-[60%]" />
            <Bone className="h-3 w-[90%]" />
            <Bone className="h-3 w-[70%]" />
            <Bone className="mt-1 h-9 w-[92px] rounded-lg" />
          </div>
        ))}
      </div>
    );
  }

  if (layout === 'list') {
    return (
      <div className="flex flex-col gap-2.5">
        {state.alternatives.map((alt, i) => (
          <div
            key={`${i}-${alt.name}`}
            className={
              i === 0
                ? 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border-[1.5px] border-gold bg-[#fffaf0] p-3.5'
                : 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-[rgba(26,26,26,0.12)] bg-card p-3.5'
            }
          >
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className="text-[15px] font-semibold">{alt.name}</span>
              <span className="text-[12.5px] leading-[1.4] text-ink-2">{alt.why}</span>
            </span>
            <Button
              variant="dark"
              size="sm"
              disabled={busy}
              onClick={() => onUse(alt)}
              className="px-4 tracking-[0.06em]"
            >
              Use
            </Button>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2.5 @2xl:grid-cols-3">
      {state.alternatives.map((alt, i) => (
        <div
          key={`${i}-${alt.name}`}
          className="flex flex-col gap-2 rounded-[10px] border border-border bg-card p-3.5"
        >
          <span className="text-[14.5px] font-semibold">{alt.name}</span>
          <span className="grow text-[12.5px] leading-[1.45] text-ink-2">{alt.why}</span>
          <Button
            variant="dark"
            size="xs"
            disabled={busy}
            onClick={() => onUse(alt)}
            className="self-start"
          >
            Use this
          </Button>
        </div>
      ))}
    </div>
  );
}
