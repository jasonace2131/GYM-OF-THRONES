'use client';

import type { SwapAlternative, WorkoutAiQuotaView } from '@got/shared';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { PlainButton } from '../ui';
import { SwapAlternatives, type SwapState } from './SwapPanel';

/**
 * The phone's Swap: a bottom sheet (PhoneSwap.dc.html) on the portal's
 * existing `ui/sheet`, with the handle, the three alternatives as full-width
 * rows and "Keep <name>" to close.
 */
export function SwapSheet({
  original,
  state,
  quota,
  busy,
  onUse,
  onRetry,
  onClose,
}: {
  original: string | null;
  state: SwapState | null;
  quota: WorkoutAiQuotaView | null;
  busy: boolean;
  onUse: (alternative: SwapAlternative) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={original !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="gap-3.5 rounded-t-[20px] px-[18px] pt-2.5 pb-[calc(24px+env(safe-area-inset-bottom,0px))]"
      >
        <span aria-hidden className="h-[5px] w-10 self-center rounded-[3px] bg-[#d8d4cd]" />
        <SheetHeader className="gap-1 p-0">
          <SheetTitle className="font-display text-[21px] font-bold">Swap {original}</SheetTitle>
          <SheetDescription className="text-[13.5px] leading-[1.45] text-ink-2">
            Same muscles, your level, equipment the gym has. Uses 1 AI action
            {quota === null ? '' : ` — ${Math.max(0, quota.remaining)} left today`}.
          </SheetDescription>
        </SheetHeader>
        {state === null ? null : (
          <SwapAlternatives
            state={state}
            busy={busy}
            onUse={onUse}
            onRetry={onRetry}
            layout="list"
          />
        )}
        <PlainButton tone="ghost" className="h-12 w-full text-[14px]" onClick={onClose}>
          Keep {original}
        </PlainButton>
      </SheetContent>
    </Sheet>
  );
}
