'use client';

import { IconWarning } from '../icons';
import { Notice, PlainButton } from '../ui';
import type { SessionStarter } from './useSessionStarter';

/**
 * What a Start button says back, under THAT button: the inline "a workout is
 * already open" choice (spec §5), or why the start failed. Nothing otherwise.
 */
export function StartFeedback({
  starter,
  startKey,
}: {
  starter: SessionStarter;
  startKey: string;
}) {
  const { state } = starter;
  if (state.kind === 'error' && state.key === startKey) {
    return (
      <Notice tone="warn" role="alert" icon={<IconWarning />}>
        {state.message}
      </Notice>
    );
  }
  if (state.kind !== 'conflict' || state.key !== startKey) return null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl border border-[#efd9a8] bg-warn-bg px-4 py-3.5 text-[#5c3f0f]"
    >
      <p className="m-0 text-[13.5px] leading-[1.5]">
        <strong className="font-semibold">You already have a workout open.</strong> Carry on with
        it, or discard it and start this one — its ticked sets go with it.
      </p>
      <div className="grid grid-cols-1 gap-2 @md:flex @md:flex-wrap">
        <PlainButton tone="dark" className="h-11" onClick={starter.continueOpen}>
          Continue it
        </PlainButton>
        <PlainButton tone="ghost" className="h-11" onClick={() => void starter.discardAndStart()}>
          Discard it and start this one
        </PlainButton>
      </div>
    </div>
  );
}
