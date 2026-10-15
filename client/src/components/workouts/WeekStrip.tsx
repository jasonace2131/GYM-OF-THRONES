import type { WeekCell, WeekKind } from '@/lib/workouts/today';
import { cn } from '@/lib/utils';
import { IconCheck } from './icons';

/**
 * THIS WEEK: seven circles, Monday to Sunday. A green tick is a check-in or
 * a finished workout (today too, once it is done), blue is a booked class,
 * gold is today, a gold ring is a planned session, a dashed ring is rest.
 * `compact` is the phone's 32px version without captions
 * (PhoneToday.dc.html, PhoneHubCoach.dc.html).
 */

const CIRCLE: Record<WeekKind, string> = {
  done: 'border-ok bg-ok text-white',
  class: 'border-[#b9cbee] bg-info-bg text-info',
  today:
    'border-gold bg-gold text-night ring-[3px] ring-[#f7f6f3] ring-offset-[2px] ring-offset-gold',
  train: 'border-gold bg-card text-foreground',
  rest: 'border-dashed border-[rgba(26,26,26,0.22)] bg-transparent text-ink-3',
};

const CAPTION: Record<WeekKind, string> = {
  done: 'text-ok',
  class: 'text-info',
  today: 'text-foreground',
  train: 'text-ink-2',
  rest: 'text-ink-3',
};

export function WeekStrip({ cells, compact = false }: { cells: WeekCell[]; compact?: boolean }) {
  return (
    <ol className={cn('m-0 grid list-none grid-cols-7 p-0', compact ? 'gap-1' : 'gap-1.5')}>
      {cells.map((cell) => (
        <li key={cell.civil} className="flex flex-col items-center gap-1.5">
          <span
            className={cn(
              'font-bold tracking-[0.08em] text-ink-3',
              compact ? 'text-[10px]' : 'text-[11px]',
            )}
          >
            {compact ? cell.letter : cell.dow}
          </span>
          <span
            className={cn(
              'flex items-center justify-center rounded-full border-2 font-bold',
              compact ? 'h-8 w-8 text-[12.5px]' : 'h-[38px] w-[38px] text-[13px]',
              CIRCLE[cell.kind],
            )}
            aria-label={`${cell.dow} ${cell.date}: ${cell.caption}`}
          >
            {cell.kind === 'done' ? (
              <IconCheck size={compact ? 14 : 16} />
            ) : (
              <span aria-hidden>{cell.date}</span>
            )}
          </span>
          {compact ? null : (
            <span
              className={cn(
                'text-center text-[11px] leading-[1.3] font-semibold',
                CAPTION[cell.kind],
              )}
              aria-hidden
            >
              {cell.caption}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
