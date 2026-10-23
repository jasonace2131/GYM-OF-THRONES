import type { DraftDayCard as DraftDayCardView } from '@/lib/workouts/draftProgress';
import { WEEKDAY_LONG } from '@/lib/workouts/labels';
import { aboutMinutes, dose, exerciseCount } from '@/lib/workouts/planView';
import { cn } from '@/lib/utils';
import { Bone, Tag } from '../ui';

/**
 * One day on the generating screen: READY with its rows, WRITING with the
 * rows so far plus skeletons, or a pending skeleton. Every state reserves
 * the same height band, so a day landing does not shove the next one.
 */
export function DraftDayCard({ card, expected }: { card: DraftDayCardView; expected: number }) {
  const kicker = `DAY ${card.index + 1} · ${WEEKDAY_LONG[card.weekday]?.toUpperCase() ?? ''}`;
  const rows = card.day?.exercises ?? [];
  const missing = Math.max(0, expected - rows.length);

  return (
    <article
      aria-label={`${kicker}: ${card.state === 'ready' ? card.day?.title : card.state === 'writing' ? 'being written' : 'not written yet'}`}
      aria-busy={card.state !== 'ready' || undefined}
      className={cn(
        'flex flex-col overflow-hidden rounded-[14px] bg-card',
        card.state === 'ready'
          ? 'border-2 border-ok shadow-[var(--p-shadow)]'
          : card.state === 'writing'
            ? 'border-[1.5px] border-gold shadow-[var(--p-shadow)]'
            : 'border border-border',
      )}
    >
      <header className="flex flex-col gap-1 border-b border-[rgba(26,26,26,0.08)] bg-[#fbfaf8] px-[18px] py-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-bold tracking-[0.14em] text-ink-3 uppercase">
            {kicker}
          </span>
          {card.state === 'ready' ? (
            <Tag tone="ok" className="text-[11px]">
              Ready
            </Tag>
          ) : card.state === 'writing' ? (
            <Tag tone="warn" className="text-[11px]">
              Writing
            </Tag>
          ) : null}
        </div>
        {card.day === null ? (
          <>
            <Bone className="h-[18px] w-[58%] rounded-[7px]" />
            <Bone className="h-[11px] w-[32%] rounded-[5px]" />
          </>
        ) : (
          <>
            <h3 className="m-0 font-display text-[20px] font-bold">{card.day.title}</h3>
            <span className="text-[12.5px] text-ink-2">
              {aboutMinutes(card.day.minutes)} · {exerciseCount(card.day.exercises.length)}
            </span>
          </>
        )}
      </header>
      <ol className="m-0 list-none p-0">
        {rows.map((exercise, i) => (
          <li
            key={`${i}-${exercise.name}`}
            className="flex items-center justify-between gap-2.5 border-b border-[rgba(26,26,26,0.06)] px-[18px] py-3 last:border-b-0"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[14px] font-semibold">{exercise.name}</span>
              <span className="text-[12.5px] text-ink-3">{exercise.muscles}</span>
            </span>
            <span className="font-display text-[14px] font-bold whitespace-nowrap">
              {dose(exercise)}
            </span>
          </li>
        ))}
        {card.state === 'ready'
          ? null
          : Array.from({ length: missing }, (_, i) => (
              <li
                key={`bone-${i}`}
                className="flex flex-col gap-[7px] border-b border-[rgba(26,26,26,0.06)] px-[18px] py-3.5 last:border-b-0"
              >
                <Bone
                  className={cn(
                    'h-3',
                    ['w-[62%]', 'w-[54%]', 'w-[46%]', 'w-[58%]', 'w-[50%]'][i % 5],
                  )}
                />
                <Bone
                  className={cn(
                    'h-2.5',
                    ['w-[38%]', 'w-[30%]', 'w-[26%]', 'w-[34%]', 'w-[28%]'][i % 5],
                  )}
                />
              </li>
            ))}
      </ol>
    </article>
  );
}
