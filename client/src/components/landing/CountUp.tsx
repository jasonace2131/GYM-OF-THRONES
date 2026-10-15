'use client';

import { useEffect, useRef, useState } from 'react';

interface CountUpProps {
  value: number;
  suffix?: string;
  durationMs?: number;
}

/**
 * Counts from zero to `value` the first time it scrolls into view.
 *
 * Numbers that climb read as live readings rather than static copy —
 * the cheapest way to make a stats bar feel switched on. Renders the
 * final value immediately when reduced motion is requested.
 */
export default function CountUp({ value, suffix = '', durationMs = 800 }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let frame = 0;
    let startedAt = 0;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();

        // Reduced motion resolves straight to the final value. Checked
        // here rather than in the effect body so state is only ever set
        // from the observer callback, never synchronously on mount.
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          setShown(value);
          return;
        }

        const step = (now: number) => {
          if (!startedAt) startedAt = now;
          const progress = Math.min((now - startedAt) / durationMs, 1);
          // easeOutExpo — fast off the line, long settle
          const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
          setShown(Math.round(value * eased));
          if (progress < 1) frame = requestAnimationFrame(step);
        };

        frame = requestAnimationFrame(step);
      },
      { threshold: 0.4 },
    );

    observer.observe(el);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value, durationMs]);

  return (
    <span ref={ref}>
      {shown}
      <i>{suffix}</i>
    </span>
  );
}
