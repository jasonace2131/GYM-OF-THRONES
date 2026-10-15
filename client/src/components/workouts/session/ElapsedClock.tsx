'use client';

import { useEffect, useState } from 'react';
import { elapsedClock } from '@/lib/workouts/restTimer';

/**
 * Time in the workout, under the day title — from `startedAt`, so it is right
 * after a reload or a phone that slept. Its own component, so only it
 * re-renders every second.
 */
export function ElapsedClock({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span
      role="timer"
      aria-label="Time in this workout"
      className="font-display text-[12.5px] font-semibold text-ink-3 tabular-nums"
    >
      {elapsedClock(now - Date.parse(startedAt))}
    </span>
  );
}
