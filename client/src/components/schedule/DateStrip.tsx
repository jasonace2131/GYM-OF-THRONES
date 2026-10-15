'use client';

import { useEffect, useRef } from 'react';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { dayNumber, longDay, shortWeekday } from '@/lib/schedule/labels';
import { cn } from '@/lib/utils';

interface DateStripProps {
  days: string[];
  today: string;
  selected: string;
  /** Days the member holds a place in a class: a seat or a waitlist place. */
  markedDays: ReadonlySet<string>;
  onSelect: (day: string) => void;
}

/**
 * The member's booking window as a thumb-sized strip of days (a fortnight, or
 * three weeks on a priority plan) — the booking-app pattern members already
 * know. A radiogroup: arrow keys move the selection.
 *
 * The dot and its spoken word say "a booking", not "a class": a waitlist place
 * marks the day too, and it is not a class yet.
 */
export function DateStrip({ days, today, selected, markedDays, onSelect }: DateStripProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [selected]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = days.indexOf(selected);
    const next =
      event.key === 'ArrowRight'
        ? days[index + 1]
        : event.key === 'ArrowLeft'
          ? days[index - 1]
          : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onSelect(next);
  };

  return (
    <ScrollArea className="w-full whitespace-nowrap">
      <div role="radiogroup" aria-label="Day" className="flex gap-2 pb-3" onKeyDown={onKeyDown}>
        {days.map((day) => {
          const isSelected = day === selected;
          const marked = markedDays.has(day);
          return (
            <button
              key={day}
              ref={isSelected ? selectedRef : undefined}
              type="button"
              role="radio"
              aria-checked={isSelected}
              tabIndex={isSelected ? 0 : -1}
              aria-label={`${longDay(day)}${marked ? ', you have a booking' : ''}`}
              onClick={() => onSelect(day)}
              className={cn(
                'flex w-[52px] shrink-0 flex-col items-center gap-0.5 rounded-xl border py-2 font-display transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isSelected
                  ? 'border-night bg-night text-white'
                  : cn(
                      'bg-card text-foreground hover:bg-accent',
                      day === today ? 'border-gold' : 'border-border',
                    ),
              )}
            >
              <span
                className={cn(
                  'text-[9.5px] font-semibold uppercase tracking-[0.1em]',
                  isSelected ? 'text-gold-lit' : 'text-ink-3',
                )}
              >
                {day === today ? 'Today' : shortWeekday(day)}
              </span>
              <span className="text-lg font-semibold leading-tight">{dayNumber(day)}</span>
              <span
                aria-hidden
                className={cn(
                  'size-[5px] rounded-full',
                  marked ? (isSelected ? 'bg-gold-lit' : 'bg-gold') : 'bg-transparent',
                )}
              />
            </button>
          );
        })}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}
