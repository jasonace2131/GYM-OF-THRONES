'use client';

import { useEffect, useRef } from 'react';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { classCountLabel } from '@/lib/schedule/classDays';
import { dayNumber, longDay, shortWeekday } from '@/lib/schedule/labels';
import { cn } from '@/lib/utils';

interface DateStripProps {
  days: string[];
  today: string;
  selected: string;
  /** Days the member holds a place in a class: a seat or a waitlist place. */
  markedDays: ReadonlySet<string>;
  /** Classes per day, cancelled ones left out (`classCountsByDay`). A day absent has none. */
  classCounts: ReadonlyMap<string, number>;
  onSelect: (day: string) => void;
}

/**
 * The member's booking window as a thumb-sized strip of days (a fortnight, or
 * three weeks on a priority plan) — the booking-app pattern members already
 * know. A radiogroup: arrow keys move the selection.
 *
 * The dot and its spoken word say "a booking", not "a class": a waitlist place
 * marks the day too, and it is not a class yet.
 *
 * A day that HAS classes carries a quiet hollow ring in the same place (gym
 * report, 2026-10-30: nothing showed that later days had classes, so members
 * took an empty today for an empty timetable). The filled gold dot of a
 * booking replaces it, since a booked day has a class. Each chip's spoken name
 * says how many classes, "no classes" included, so the strip reads the same
 * without the marks.
 */
export function DateStrip({
  days,
  today,
  selected,
  markedDays,
  classCounts,
  onSelect,
}: DateStripProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Centre the selected day by scrolling the strip's OWN viewport. Not
  // `scrollIntoView`: that scrolls every scrollable ancestor too, and on a
  // phone it dragged the whole page sideways (and down, on first paint).
  useEffect(() => {
    const chip = selectedRef.current;
    const viewport = chip?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!chip || !viewport) return;
    const chipBox = chip.getBoundingClientRect();
    const viewBox = viewport.getBoundingClientRect();
    const left =
      viewport.scrollLeft + (chipBox.left - viewBox.left) - (viewport.clientWidth - chipBox.width) / 2;
    viewport.scrollTo?.({ left: Math.max(0, left), behavior: 'smooth' });
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
    // `min-w-0`: inside a grid track the strip's 14-21 chips would otherwise set
    // the track's minimum width, and every card on the page grew to ~830px.
    // See dateStripContainment.test.ts.
    <ScrollArea className="w-full min-w-0 whitespace-nowrap">
      <div role="radiogroup" aria-label="Day" className="flex gap-2 pb-3" onKeyDown={onKeyDown}>
        {days.map((day) => {
          const isSelected = day === selected;
          const marked = markedDays.has(day);
          const classes = classCounts.get(day) ?? 0;
          return (
            <button
              key={day}
              ref={isSelected ? selectedRef : undefined}
              type="button"
              role="radio"
              aria-checked={isSelected}
              tabIndex={isSelected ? 0 : -1}
              aria-label={`${longDay(day)}, ${classCountLabel(classes)}${marked ? ', you have a booking' : ''}`}
              onClick={() => onSelect(day)}
              className={cn(
                'flex w-[52px] shrink-0 flex-col items-center gap-0.5 rounded-xl border py-2 font-display transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                // Style A: the selected day is the strip's one flat gold accent.
                isSelected
                  ? 'border-gold bg-gold text-night'
                  : cn(
                      'bg-card text-foreground hover:bg-accent',
                      day === today ? 'border-gold' : 'border-border',
                    ),
              )}
            >
              <span
                className={cn(
                  'text-[11px] font-semibold uppercase tracking-[0.1em]',
                  isSelected ? 'text-night' : 'text-ink-3',
                )}
              >
                {day === today ? 'Today' : shortWeekday(day)}
              </span>
              <span className="text-lg font-semibold leading-tight">{dayNumber(day)}</span>
              {/* One 5px slot, so every chip is the same height: a booking's
                  filled dot, else a ring for a day with classes. The ring is
                  an inset box-shadow, not a border — with no Preflight a
                  border would add 2px to this chip alone. */}
              <span
                aria-hidden
                className={cn(
                  'size-[5px] rounded-full',
                  marked
                    ? isSelected
                      ? 'bg-night'
                      : 'bg-gold'
                    : classes > 0
                      ? cn('ring-1 ring-inset', isSelected ? 'ring-night/60' : 'ring-ink-3')
                      : 'bg-transparent',
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
