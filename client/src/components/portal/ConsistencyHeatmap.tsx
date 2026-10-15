'use client';

import type { CheckInDay } from '@/lib/portalData';
import { heatmapMonthLabels } from '@/lib/dashboard/dashboardView';

/**
 * Twenty-six weeks of attendance, one square per day — the same window the
 * server's summary counts (`HEATMAP_WEEKS`), so the squares and the streak
 * can never be describing different periods.
 *
 * This replaces the wireframe's "187 all-time check-ins" tile on the
 * dashboard. A total is a number nobody feels; a wall of filled squares with
 * a visible gap in it is legible at a glance, and gyms are a habit business —
 * the gap is the motivating part.
 *
 * The grid is FLUID: each column is `1fr` with square cells, capped so the
 * squares never grow past a comfortable size. A fixed 13px column scrolled
 * sideways inside a phone card and hid the most recent weeks — the only ones
 * a member actually looks at — off the right edge.
 */
export function ConsistencyHeatmap({ days }: { days: CheckInDay[] }) {
  // Oldest-first, chunked into columns of 7 so each column is one week.
  const weeks: CheckInDay[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }

  const shade = (visits: number): string => {
    if (visits <= 0) return 'var(--p-paper3)';
    if (visits === 1) return 'rgba(201,146,42,.42)';
    return 'var(--gold)';
  };

  const months = heatmapMonthLabels(weeks.map((week) => week[0]?.date ?? ''));
  const columns = `repeat(${weeks.length}, minmax(0, 1fr))`;
  const visits = days.filter((day) => day.visits > 0).length;

  return (
    <div>
      <div
        role="img"
        aria-label={`${visits} ${visits === 1 ? 'day' : 'days'} with a visit in the last ${weeks.length} weeks`}
        // Fills its card; the cap stops squares ballooning on a wide single column.
        style={{ maxWidth: weeks.length * 22, display: 'grid', gap: 5 }}
      >
        <div
          aria-hidden
          style={{ display: 'grid', gridTemplateColumns: columns, columnGap: 3, height: 12 }}
        >
          {months.map((label, i) => (
            <div
              key={i}
              style={{
                fontSize: 9,
                lineHeight: '12px',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--p-ink3)',
                whiteSpace: 'nowrap',
                overflow: 'visible',
              }}
            >
              {label}
            </div>
          ))}
        </div>

        <div
          aria-hidden
          style={{
            display: 'grid',
            gridTemplateColumns: columns,
            gridTemplateRows: 'repeat(7, auto)',
            gridAutoFlow: 'column',
            gap: 3,
          }}
        >
          {weeks.flatMap((week) =>
            week.map((day) => (
              <div
                key={day.date}
                title={`${day.date} — ${day.visits === 0 ? 'no visit' : `${day.visits} visit${day.visits > 1 ? 's' : ''}`}`}
                style={{
                  aspectRatio: '1',
                  borderRadius: 2.5,
                  background: shade(day.visits),
                }}
              />
            )),
          )}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          marginTop: 12,
          fontSize: 10.5,
          color: 'var(--p-ink3)',
        }}
      >
        <span>Less</span>
        {['var(--p-paper3)', 'rgba(201,146,42,.42)', 'var(--gold)'].map((c) => (
          <span key={c} style={{ width: 10, height: 10, borderRadius: 2.5, background: c }} />
        ))}
        <span>More</span>
        <span style={{ marginLeft: 'auto' }}>{`Last ${weeks.length} weeks`}</span>
      </div>
    </div>
  );
}
