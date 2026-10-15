import type { WorkoutAiQuotaView } from '@got/shared';
import { quotaMeter, quotaResetLabel } from '@/lib/workouts/quota';
import { cn } from '@/lib/utils';
import { KickerHeading, Panel } from './ui';

/** AI ACTIONS TODAY: the big number, eight segments, and the price list. */
export function QuotaMeter({ quota }: { quota: WorkoutAiQuotaView }) {
  return (
    <Panel
      aria-labelledby="wk-ai-h"
      className="flex flex-col gap-3.5 px-4 py-4 @md:px-[22px] @md:py-5"
    >
      <div className="flex items-center justify-between gap-3">
        <KickerHeading id="wk-ai-h">AI actions today</KickerHeading>
        <span className="text-[12.5px] text-ink-3">{quotaResetLabel(quota)}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-display text-[34px] leading-none font-extrabold">
          {Math.max(0, quota.remaining)}
        </span>
        <span className="text-[14px] text-ink-2">of {quota.limit} left</span>
      </div>
      <div aria-hidden className="grid grid-cols-8 gap-1">
        {quotaMeter(quota).map((free, i) => (
          <span key={i} className={cn('h-2 rounded-[4px]', free ? 'bg-gold' : 'bg-[#e2ded7]')} />
        ))}
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[13px] text-[color:var(--p-ink)]">
        <li className="flex justify-between">
          <span>New plan or regenerate</span>
          <span className="font-semibold">1</span>
        </li>
        <li className="flex justify-between">
          <span>Swap an exercise</span>
          <span className="font-semibold">1</span>
        </li>
        <li className="flex justify-between">
          <span>Adjust a day</span>
          <span className="font-semibold">1</span>
        </li>
        <li className="flex justify-between">
          <span>How to do an exercise</span>
          <span className="font-bold text-ok">Free</span>
        </li>
      </ul>
    </Panel>
  );
}
