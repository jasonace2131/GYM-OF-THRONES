'use client';

import { useMemo, useRef, useState } from 'react';
import type { DailyCheckIns } from '@got/shared';
import { civilDate } from '@/lib/adminApi';

/**
 * The attendance trend, drawn by hand.
 *
 * No charting library. One area path, one stroke, and a crosshair is about
 * forty lines against this client's current zero chart dependencies; Recharts
 * would add roughly 90 kB to the bundle to draw one line.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT MUST BE READABLE, NOT MERELY SHAPED.
 *
 * A trend line you cannot query is decoration with extra steps: the viewer can
 * see that Tuesday was busy and has no way to learn how busy. So the chart
 * carries a crosshair on hover and focus, ←/→ keyboard navigation, and an
 * aria-label that states the range, the total and the peak — because the one
 * fact a screen-reader user needs must not depend on reading an SVG path.
 *
 * The series arrives DENSE (every day present, zero-filled). That is the
 * server's contract and this component relies on it: a gap would make the line
 * interpolate straight across a closed day and draw attendance that never
 * happened.
 * ─────────────────────────────────────────────────────────────────────────
 */

const VIEW_W = 640;
const VIEW_H = 170;
const PAD_TOP = 14;
const PAD_BOTTOM = 26;

export function CheckInsChart({ data }: { data: DailyCheckIns }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const days = data.days;

  const geometry = useMemo(() => {
    // A flat-zero series would divide by zero; a max of 1 renders it as a line
    // along the floor, which is the honest picture of a gym nobody visited.
    const peak = Math.max(1, ...days.map((d) => d.total));
    const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;
    const step = days.length > 1 ? VIEW_W / (days.length - 1) : 0;

    const points = days.map((day, index) => ({
      x: days.length > 1 ? index * step : VIEW_W / 2,
      y: PAD_TOP + plotH - (day.total / peak) * plotH,
    }));

    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${line} L${VIEW_W},${VIEW_H - PAD_BOTTOM} L0,${VIEW_H - PAD_BOTTOM} Z`;

    return { peak, points, line, area };
  }, [days]);

  const ticks = useMemo(() => {
    if (days.length <= 5) return days.map((d) => d.date);
    const step = (days.length - 1) / 4;
    return [0, 1, 2, 3, 4].map((i) => days[Math.round(i * step)]!.date);
  }, [days]);

  const total = useMemo(() => days.reduce((sum, d) => sum + d.total, 0), [days]);
  const peakDay = useMemo(
    () => days.reduce((best, d) => (d.total > best.total ? d : best), days[0]!),
    [days],
  );

  const shown = active === null ? null : days[active];
  const shownPoint = active === null ? null : geometry.points[active];

  const indexFromClientX = (clientX: number): number => {
    const svg = svgRef.current;
    if (svg === null || days.length === 0) return 0;
    const rect = svg.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(days.length - 1, Math.round(ratio * (days.length - 1))));
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setActive((current) => {
      const from = current ?? days.length - 1;
      const next = event.key === 'ArrowLeft' ? from - 1 : from + 1;
      return Math.max(0, Math.min(days.length - 1, next));
    });
  };

  if (days.length === 0) return null;

  return (
    <div className="a-chart">
      <svg
        ref={svgRef}
        className="a-chart-svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        tabIndex={0}
        aria-label={
          `Check-ins from ${civilDate(data.from)} to ${civilDate(data.to)}. ` +
          `${total} in total. Busiest day ${civilDate(peakDay.date)} with ${peakDay.total}. ` +
          `Use left and right arrow keys to read individual days.`
        }
        onMouseMove={(event) => setActive(indexFromClientX(event.clientX))}
        onMouseLeave={() => setActive(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
      >
        <defs>
          <linearGradient id="a-chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.26" />
            <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0.25, 0.5, 0.75].map((fraction) => {
          const y = PAD_TOP + (VIEW_H - PAD_TOP - PAD_BOTTOM) * fraction;
          return <line key={fraction} className="a-chart-grid" x1="0" y1={y} x2={VIEW_W} y2={y} />;
        })}

        <path d={geometry.area} fill="url(#a-chart-fill)" />
        <path className="a-chart-line" d={geometry.line} />

        {shownPoint !== undefined && shownPoint !== null && (
          <>
            <line
              className="a-chart-cross"
              x1={shownPoint.x}
              y1={PAD_TOP}
              x2={shownPoint.x}
              y2={VIEW_H - PAD_BOTTOM}
            />
            <circle className="a-chart-dot" cx={shownPoint.x} cy={shownPoint.y} r="4.5" />
          </>
        )}
      </svg>

      {/* Up to five evenly-spaced ticks rather than just the two ends. Two
          labels tell you the window; five let you find a specific week without
          hovering, which is what somebody scanning for "when did it dip" is
          actually doing. Fewer than five days label every point. */}
      <div className="a-chart-axis" aria-hidden>
        {ticks.map((day) => (
          <span key={day}>{civilDate(day)}</span>
        ))}
      </div>

      {/* The readout. `aria-live` so arrow-key navigation is announced without
          the whole figure being re-read on every step. */}
      <div className="a-chart-readout" aria-live="polite">
        {shown === null || shown === undefined ? (
          <span className="a-chart-hint">
            {total} check-ins over {days.length} days · peak {peakDay.total} on{' '}
            {civilDate(peakDay.date)}
          </span>
        ) : (
          <>
            <strong>{civilDate(shown.date)}</strong>
            <span className="a-chart-figure">{shown.total} check-ins</span>
            <span className="a-chart-split">
              {shown.selfScan} self-scan · {shown.staff} by staff
              {shown.denied > 0 && ` · ${shown.denied} denied`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
