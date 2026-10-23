'use client';

import { useEffect, useRef } from 'react';
import { hhmmTo12h } from '@/lib/gymTime';
import { gymParts } from '@/lib/schedule/gymClock';
import { dayNumber, shortWeekday } from '@/lib/schedule/labels';
import { layoutWeek, type GridEvent } from '@/lib/schedule/weekLayout';
import { cn } from '@/lib/utils';

export type BlockTone =
  | 'booked'
  | 'waitlist'
  | 'attended'
  | 'other'
  | 'coach'
  | 'coach-live'
  | 'cancelled';

const TONES: Record<BlockTone, string> = {
  booked: 'bg-night text-white shadow-[inset_3px_0_0_var(--gold)]',
  waitlist: 'bg-warn-bg text-warn shadow-[inset_3px_0_0_var(--p-warn)]',
  attended: 'bg-ok-bg text-ok shadow-[inset_3px_0_0_var(--p-ok)]',
  other: 'bg-paper-3 text-ink-2',
  coach: 'border border-input bg-card text-foreground shadow-[inset_3px_0_0_var(--gold)]',
  'coach-live': 'bg-night text-white shadow-[inset_3px_0_0_var(--gold)]',
  cancelled: 'bg-paper-3 text-ink-3 line-through',
};

export interface BlockDescription {
  title: string;
  detail: string;
  tone: BlockTone;
  /** Full accessible name, e.g. "Yoga, Wed 16 Sep 6:00 PM, Booked". */
  label: string;
}

interface WeekTimeGridProps<T extends GridEvent> {
  /** yyyy-mm-dd, in column order. */
  days: string[];
  today: string;
  now: Date;
  events: readonly T[];
  /** Pixels per hour. */
  hourHeight?: number;
  describe: (event: T) => BlockDescription;
  onSelect: (event: T) => void;
}

/**
 * A read-only time-grid: hours down the side, days across, classes placed by
 * their Manila start and end. Event blocks and a current-time line, without
 * drag and drop.
 */
export function WeekTimeGrid<T extends GridEvent>({
  days,
  today,
  now,
  events,
  hourHeight = 44,
  describe,
  onSelect,
}: WeekTimeGridProps<T>) {
  const layout = layoutWeek(events, days);
  const hours = layout.endHour - layout.startHour;
  const px = (minutes: number): number => (minutes / 60) * hourHeight;
  const scrollRef = useRef<HTMLDivElement>(null);
  const nowParts = gymParts(now);
  const columns = `3.25rem repeat(${days.length}, minmax(0, 1fr))`;

  // Open at 6 AM rather than at the grid's top edge.
  useEffect(() => {
    if (scrollRef.current !== null) {
      scrollRef.current.scrollTop = Math.max(0, (6 - layout.startHour) * hourHeight);
    }
  }, [layout.startHour, hourHeight]);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="grid border-b border-border" style={{ gridTemplateColumns: columns }}>
        <div />
        {days.map((day) => (
          <div
            key={day}
            className="py-2 text-center font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3"
          >
            {shortWeekday(day)}
            <span
              className={cn(
                'block text-base tracking-normal',
                day === today ? 'text-gold-deep' : 'text-foreground',
              )}
            >
              {dayNumber(day)}
            </span>
          </div>
        ))}
      </div>

      {/* One scroller per screen on a phone: the page. A 520px box scrolling
          inside a scrolling page trapped the thumb; from `sm` it returns. */}
      <div ref={scrollRef} className="sm:max-h-[520px] sm:overflow-y-auto">
        <div className="relative grid" style={{ gridTemplateColumns: columns, height: hours * hourHeight }}>
          <div className="relative">
            {Array.from({ length: hours - 1 }, (_, i) => layout.startHour + i + 1).map((hour) => (
              <span
                key={hour}
                className="absolute right-1.5 -translate-y-1/2 whitespace-nowrap text-[11px] text-ink-3"
                style={{ top: px((hour - layout.startHour) * 60) }}
              >
                {hhmmTo12h(`${String(hour).padStart(2, '0')}:00`).replace(':00', '')}
              </span>
            ))}
          </div>

          {layout.days.map(({ date, events: placed }) => (
            <div key={date} className={cn('relative border-l border-border', date === today && 'bg-gold/5')}>
              {Array.from({ length: hours - 1 }, (_, i) => (
                <div
                  key={i}
                  className="absolute inset-x-0 border-t border-border/60"
                  style={{ top: px((i + 1) * 60) }}
                />
              ))}

              {placed.map((item) => {
                const block = describe(item.event);
                return (
                  <button
                    key={item.event.id}
                    type="button"
                    aria-label={block.label}
                    onClick={() => onSelect(item.event)}
                    className={cn(
                      'absolute flex flex-col gap-px overflow-hidden rounded-lg px-1.5 py-1 text-left',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      TONES[block.tone],
                    )}
                    style={{
                      top: px(item.topMin),
                      height: Math.max(px(item.heightMin) - 2, 22),
                      left: `calc(${(item.lane / item.lanes) * 100}% + 2px)`,
                      width: `calc(${100 / item.lanes}% - 4px)`,
                    }}
                  >
                    <span className="truncate font-display text-[12px] font-semibold leading-tight">
                      {block.title}
                    </span>
                    <span className="truncate text-[11px] leading-tight opacity-85">{block.detail}</span>
                  </button>
                );
              })}

              {date === today &&
              nowParts.minutes >= layout.startHour * 60 &&
              nowParts.minutes <= layout.endHour * 60 ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger before:absolute before:-left-1 before:-top-[5px] before:size-2 before:rounded-full before:bg-danger"
                  style={{ top: px(nowParts.minutes - layout.startHour * 60) }}
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
