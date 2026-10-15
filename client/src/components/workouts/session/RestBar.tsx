'use client';

import { useEffect, useRef, useState } from 'react';
import { clock, restAnnouncement, restRemaining, type RestState } from '@/lib/workouts/restTimer';
import { BAR_INNER } from './bars';

/**
 * The dark rest bar that replaces Prev / Next while resting
 * (PhoneSession.dc.html): REST · NEXT SET n, the clock, +15 s, Skip.
 *
 * The clock is `endsAt - now` on every tick, so it is right after the phone
 * has slept. At zero the phone buzzes (where it can) and the bar hands back
 * to Prev / Next. The live region speaks at the start, every 15 s and never
 * per second; the visible digits are hidden from it.
 */
export function RestBar({
  rest,
  onAdd,
  onSkip,
  onDone,
}: {
  rest: RestState;
  onAdd: () => void;
  onSkip: () => void;
  onDone: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const remaining = restRemaining(rest, now);
  const [initial] = useState(remaining);
  // Blank between marks, so each mark is a change the region announces.
  const spoken = restAnnouncement(remaining, remaining === initial) ?? '';
  const finished = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (remaining > 0 || finished.current) return;
    finished.current = true;
    if (typeof navigator.vibrate === 'function') navigator.vibrate([200, 100, 200]);
    onDone();
  }, [remaining, onDone]);

  return (
    <div className="shrink-0 bg-sidebar text-[#f6f4f0]">
      <div className={`${BAR_INNER} grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2`}>
        <div role="timer" aria-live="polite" aria-atomic="true" className="flex flex-col gap-px">
          <span
            aria-hidden
            className="text-[10.5px] font-bold tracking-[0.16em] text-[#a9a39a] uppercase"
          >
            Rest · Next set {rest.nextSet}
          </span>
          <span
            aria-hidden
            className="font-display text-[32px] leading-none font-extrabold text-gold-lit tabular-nums"
          >
            {clock(remaining)}
          </span>
          <span className="sr-only">{spoken}</span>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="h-12 cursor-pointer rounded-[10px] border-[1.5px] border-[rgba(255,255,255,0.25)] bg-transparent px-3.5 text-[14px] font-semibold text-[#f6f4f0] transition-colors hover:border-[rgba(255,255,255,0.5)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-lit motion-reduce:transition-none"
          aria-label="Add 15 seconds of rest"
        >
          +15 s
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="h-12 cursor-pointer rounded-[10px] border-0 bg-gold px-4 text-[14px] font-bold text-night transition-colors hover:bg-gold-lit focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-lit motion-reduce:transition-none"
          aria-label="Skip the rest"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
