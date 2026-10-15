'use client';

import { formatGymTime } from '@/lib/gymTime';
import type { Measurement } from '@/lib/progress/types';

/**
 * The weight trend. Moved out of the member page unchanged so the coach's
 * drill-down draws the same line the member sees.
 *
 * Legacy markup only: this folder is not Tailwind-scanned (see tailwind.css).
 * Needs at least two weighed points; the caller says what to show otherwise.
 */
export function WeightChart({ points }: { points: Measurement[] }) {
  const w = 100;
  const h = 34;
  const values = points.map((p) => (p.weightGrams ?? 0) / 1000);
  const min = Math.min(...values) - 0.6;
  const max = Math.max(...values) + 0.6;
  const span = max - min || 1;

  const coords = values.map((value, i) => ({
    x: (i / (values.length - 1)) * w,
    y: h - ((value - min) / span) * h,
  }));

  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  const last = coords[coords.length - 1];

  // Civil dates, read back at UTC midnight and formatted in UTC: the day the
  // gym filed the reading under, never shifted by the viewer's zone.
  const dayLabel = (day: string | undefined): string =>
    day === undefined
      ? ''
      : formatGymTime(`${day}T00:00:00Z`, 'UTC', { day: 'numeric', month: 'short' });

  return (
    <div>
      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: 92, display: 'block' }}
          role="img"
          aria-label={`Weight trend over ${points.length} readings`}
        >
          <path d={area} fill="rgba(201,146,42,.14)" />
          <path
            d={line}
            fill="none"
            stroke="var(--gold)"
            strokeWidth={1.6}
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {/* The latest point, drawn OUTSIDE the SVG: `preserveAspectRatio="none"`
            stretches the chart to any width, and an SVG <circle> stretched
            with it became a wide flat ellipse. A positioned dot stays round. */}
        {last ? (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: `${(last.x / w) * 100}%`,
              top: `${(last.y / h) * 100}%`,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--gold-dark)',
              boxShadow: '0 0 0 2px var(--p-paper)',
              transform: 'translate(-50%, -50%)',
            }}
          />
        ) : null}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
        <span style={{ fontSize: 10.5, color: 'var(--p-ink3)' }}>
          {dayLabel(points[0]?.businessDate)}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--p-ink3)' }}>
          {dayLabel(points[points.length - 1]?.businessDate)}
        </span>
      </div>
    </div>
  );
}
