'use client';

import type { StartSessionBody } from '@got/shared';
import { startKey } from '@/lib/workouts/todaySource';
import { IconPlay, IconSpinner } from '../icons';
import { buttonClass } from '../ui';
import { StartFeedback } from './StartFeedback';
import type { SessionStarter } from './useSessionStarter';
import { useMemberCanWrite } from '@/components/portal/MembershipGate';

/**
 * "Start this day" at the foot of a plan's day card — any day of any plan,
 * not only today's (spec §1.2). Full width on a phone, beside the card's edge
 * from @2xl; the inline "already open" choice appears right under it.
 */
export function StartDayButton({
  starter,
  body,
  dayName,
}: {
  starter: SessionStarter;
  body: StartSessionBody;
  /** For the accessible name: "Start this day: Full body B". */
  dayName: string;
}) {
  const canWrite = useMemberCanWrite();
  const key = startKey(body);
  // A lapsed member reads their plans; starting a workout is a write.
  if (!canWrite) return null;
  const starting = starter.state.kind === 'starting' && starter.state.key === key;
  return (
    <div className="flex flex-col gap-2.5 @2xl:items-end">
      <button
        type="button"
        disabled={starter.state.kind === 'starting'}
        onClick={() => void starter.start(body)}
        aria-label={`Start this day: ${dayName}`}
        className={buttonClass('gold', 'sm', 'w-full cursor-pointer @2xl:w-auto')}
      >
        {starting ? (
          <IconSpinner size={16} className="motion-safe:animate-spin" />
        ) : (
          <IconPlay size={16} />
        )}
        {starting ? 'Starting…' : 'Start this day'}
      </button>
      <div className="w-full">
        <StartFeedback starter={starter} startKey={key} />
      </div>
    </div>
  );
}
