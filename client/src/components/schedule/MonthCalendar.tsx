'use client';

import { TZDate } from '@date-fns/tz';
import { Calendar, CalendarDayButton } from '@/components/ui/calendar';
import { GYM_TIMEZONE } from '@/lib/gymTime';
import type { BookingDot } from '@/lib/schedule/bookingState';
import { cn } from '@/lib/utils';

/** A gym day as a Date at Manila midnight, which react-day-picker expects with `timeZone`. */
const toDate = (day: string): Date => {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new TZDate(year, month - 1, date, GYM_TIMEZONE);
};

const toDay = (value: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: GYM_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);

const KINDS = ['booked', 'waitlist', 'attended', 'other'] as const;

const DOT_COLOUR: Record<BookingDot, string> = {
  booked: 'bg-gold',
  waitlist: 'bg-warn',
  attended: 'bg-ok',
  other: 'bg-ink-3',
};

/**
 * Said out loud for screen readers, and for anyone who cannot separate the
 * four dot colours — the dot alone would be information carried by colour.
 *
 * 'other' also covers a waitlist place the class started without ("No place"),
 * which `bookingState` deliberately files under 'other' rather than 'waitlist'.
 */
const DOT_WORD: Record<BookingDot, string> = {
  booked: 'booked',
  waitlist: 'on the waitlist',
  attended: 'attended',
  other: 'cancelled, missed or no place',
};

const LEGEND: readonly [BookingDot, string][] = [
  ['booked', 'Booked'],
  ['waitlist', 'Waitlist'],
  ['attended', 'Attended'],
  ['other', 'Other'],
];

interface MonthCalendarProps {
  /** yyyy-mm-dd */
  selected: string;
  /** yyyy-mm-01 of the month on screen */
  month: string;
  marks: ReadonlyMap<string, BookingDot>;
  onSelect: (day: string) => void;
  onMonthChange: (firstOfMonth: string) => void;
}

export function MonthCalendar({
  selected,
  month,
  marks,
  onSelect,
  onMonthChange,
}: MonthCalendarProps) {
  const daysWith = (dot: BookingDot): Date[] =>
    [...marks].filter(([, value]) => value === dot).map(([day]) => toDate(day));

  return (
    // The selected day stays a flat gold accent (Style A): shadcn's calendar
    // fills it with --primary, which is ink on member surfaces.
    <div className="rounded-xl border border-border bg-card p-3 [--primary:var(--gold)] [--primary-foreground:var(--p-night)]">
      <Calendar
        mode="single"
        required
        timeZone={GYM_TIMEZONE}
        weekStartsOn={1}
        showOutsideDays
        selected={toDate(selected)}
        onSelect={(value) => onSelect(toDay(value))}
        month={toDate(month)}
        onMonthChange={(value) => onMonthChange(`${toDay(value).slice(0, 7)}-01`)}
        modifiers={{
          booked: daysWith('booked'),
          waitlist: daysWith('waitlist'),
          attended: daysWith('attended'),
          other: daysWith('other'),
        }}
        /**
         * The marker is a real element inside the day button, through shadcn's
         * own `DayButton` slot — not a ::after on the day CELL. react-day-picker
         * puts `modifiersClassNames` on the gridcell, one level above the button
         * that actually paints, so a pseudo-element there never appeared at all.
         */
        components={{
          DayButton: ({ day, modifiers, children, ...props }) => {
            const kind = KINDS.find((k) => modifiers[k]);
            return (
              <CalendarDayButton day={day} modifiers={modifiers} {...props}>
                {children}
                {kind === undefined ? null : (
                  <>
                    <span
                      aria-hidden
                      className={cn(
                        'size-1.5 rounded-full opacity-100',
                        // On the selected day the fill is gold, so a gold dot
                        // would vanish into it. Switch to the ink gold carries.
                        modifiers.selected ? 'bg-night' : DOT_COLOUR[kind],
                      )}
                    />
                    <span className="sr-only">{DOT_WORD[kind]}</span>
                  </>
                )}
              </CalendarDayButton>
            );
          },
        }}
        // 44px cells (a full touch target) wherever seven of them fit —
        // 370px and up; 36px below, where 7 x 44 overflows the page gutter.
        className="w-full p-0 [--cell-size:2.25rem] min-[370px]:[--cell-size:2.75rem]"
      />
      <div className="flex flex-wrap gap-3 px-1.5 pt-3 text-[11.5px] text-ink-3">
        {LEGEND.map(([key, label]) => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn('size-[7px] rounded-full', DOT_COLOUR[key])} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
