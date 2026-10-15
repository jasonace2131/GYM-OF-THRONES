import { gymParts } from './gymClock';

export interface GridEvent {
  id: string;
  startsAt: string;
  endsAt: string;
}

export interface PlacedEvent<T extends GridEvent> {
  event: T;
  /** Minutes below the grid's top edge. */
  topMin: number;
  heightMin: number;
  /** Column within an overlap cluster, 0-based. */
  lane: number;
  /** How many lanes the cluster needs. */
  lanes: number;
}

export interface WeekLayout<T extends GridEvent> {
  startHour: number;
  endHour: number;
  days: { date: string; events: PlacedEvent<T>[] }[];
}

/** The gym's opening hours (5:00 AM – 10:00 PM), stretched to fit any class outside them. */
export const DEFAULT_GRID_HOURS = { startHour: 5, endHour: 22 } as const;
const MIN_BLOCK_MINUTES = 15;

interface Span<T extends GridEvent> {
  event: T;
  date: string;
  start: number;
  end: number;
}

export function layoutWeek<T extends GridEvent>(
  events: readonly T[],
  days: readonly string[],
  bounds: { startHour: number; endHour: number } = DEFAULT_GRID_HOURS,
): WeekLayout<T> {
  const wanted = new Set(days);
  const spans: Span<T>[] = [];

  for (const event of events) {
    const start = gymParts(event.startsAt);
    if (!wanted.has(start.date)) continue;
    const end = gymParts(event.endsAt);
    // A class running past midnight is drawn to the bottom of its start day.
    const endMinutes = end.date === start.date ? end.minutes : 24 * 60;
    spans.push({
      event,
      date: start.date,
      start: start.minutes,
      end: Math.max(endMinutes, start.minutes + MIN_BLOCK_MINUTES),
    });
  }

  let startHour = bounds.startHour;
  let endHour = bounds.endHour;
  for (const span of spans) {
    startHour = Math.min(startHour, Math.floor(span.start / 60));
    endHour = Math.max(endHour, Math.ceil(span.end / 60));
  }

  return {
    startHour,
    endHour,
    days: days.map((date) => ({
      date,
      events: placeDay(
        spans.filter((span) => span.date === date),
        startHour,
      ),
    })),
  };
}

/** Greedy lanes within clusters of overlapping classes. */
function placeDay<T extends GridEvent>(spans: Span<T>[], startHour: number): PlacedEvent<T>[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const placed: PlacedEvent<T>[] = [];

  let cluster: { span: Span<T>; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;

  const flush = (): void => {
    const lanes = laneEnds.length;
    for (const { span, lane } of cluster) {
      placed.push({
        event: span.event,
        topMin: span.start - startHour * 60,
        heightMin: span.end - span.start,
        lane,
        lanes,
      });
    }
    cluster = [];
    laneEnds = [];
    clusterEnd = -1;
  };

  for (const span of sorted) {
    if (cluster.length > 0 && span.start >= clusterEnd) flush();

    let lane = laneEnds.findIndex((end) => end <= span.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(span.end);
    } else {
      laneEnds[lane] = span.end;
    }

    cluster.push({ span, lane });
    clusterEnd = Math.max(clusterEnd, span.end);
  }
  if (cluster.length > 0) flush();

  return placed;
}
