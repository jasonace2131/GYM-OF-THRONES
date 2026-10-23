'use client';

import Link from 'next/link';
import type { WorkoutFeeling, WorkoutSessionSummary } from '@got/shared';
import { finishLine, savedFootnote } from '@/lib/workouts/history';
import { cn } from '@/lib/utils';
import { IconCheck, IconWarning } from '../icons';
import { Bone, Notice, buttonClass } from '../ui';
import { BAR_INNER } from '../session/bars';
import { FocusOverlay } from '../session/FocusOverlay';
import { FeelingPicker, NewBests, StatTiles, WhatYouDid } from './SummaryParts';
import { useMemberCanWrite } from '@/components/portal/MembershipGate';

const COLUMN = 'mx-auto w-full max-w-[560px]';
const HUB = '/portal/workouts';

/**
 * "Workout done" (PhoneFinish.dc.html) — full screen straight after Finish,
 * like the session it closes: the gold tick, the four tiles, any new best,
 * "How did it feel?" (saved as it is tapped), WHAT YOU DID, and BACK TO
 * WORKOUTS with the week-tick footnote.
 */
export function FinishScreen({
  summary,
  feelingBusy,
  feelingError,
  onFeeling,
}: {
  summary: WorkoutSessionSummary;
  feelingBusy: boolean;
  feelingError: string | null;
  onFeeling: (feeling: WorkoutFeeling) => void;
}) {
  // Saving the feeling is a write (PATCH sessions/:id): a lapsed member sees
  // the picker, disabled, so the screen keeps its shape.
  const canWrite = useMemberCanWrite();
  return (
    <FocusOverlay labelledBy="wk-finish-h">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <main className={cn(COLUMN, 'flex flex-col gap-3.5 px-4 pt-7 pb-3')}>
          <div className="flex flex-col items-center gap-2 text-center">
            <span
              aria-hidden
              className="flex h-16 w-16 items-center justify-center rounded-full bg-[linear-gradient(180deg,var(--gold-lit),var(--gold))] text-night shadow-[0_8px_24px_rgba(201,146,42,0.35)]"
            >
              <IconCheck size={32} strokeWidth={2.6} />
            </span>
            <h1 id="wk-finish-h" className="m-0 font-display text-[28px] font-extrabold">
              Workout done
            </h1>
            <p className="m-0 text-[14px] text-ink-2">{finishLine(summary)}</p>
          </div>

          <StatTiles summary={summary} />
          <NewBests summary={summary} />
          <FeelingPicker
            value={summary.feeling}
            busy={feelingBusy || !canWrite}
            onChange={onFeeling}
          />
          {feelingError === null ? null : (
            <Notice tone="warn" role="alert" icon={<IconWarning />}>
              {feelingError}
            </Notice>
          )}
          <WhatYouDid summary={summary} />
        </main>
      </div>

      <div className="shrink-0 border-t border-border bg-card">
        <div className={cn(BAR_INNER, 'flex flex-col gap-1.5 px-4')}>
          <Link
            href={HUB}
            className={buttonClass('gold', 'md', 'h-[50px] w-full text-[14.5px] shadow-none')}
          >
            Back to Workouts
          </Link>
          <span className="text-center text-[12.5px] text-ink-3">{savedFootnote(summary)}</span>
        </div>
      </div>
    </FocusOverlay>
  );
}

/** The finish screen's frame while its summary loads (a reload of `?just=1`). */
export function FinishScreenLoading() {
  return (
    <FocusOverlay labelledBy="wk-finish-h">
      <main className={cn(COLUMN, 'flex flex-col items-center gap-3.5 px-4 pt-7')} aria-busy="true">
        <h1 id="wk-finish-h" className="sr-only">
          Loading your workout
        </h1>
        <Bone className="h-16 w-16 rounded-full" />
        <Bone className="h-7 w-48" />
        <Bone className="h-4 w-56" />
        <Bone className="h-[180px] w-full rounded-xl" />
      </main>
    </FocusOverlay>
  );
}
