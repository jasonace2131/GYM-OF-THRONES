import Link from 'next/link';
import type { WorkoutSessionSummary } from '@got/shared';
import { recentRow } from '@/lib/workouts/history';
import { IconCheck } from './icons';
import { KickerHeading } from './ui';

export const HISTORY_HREF = '/portal/workouts/history';

/**
 * One finished workout as a row: tick · title / when · weight moved, the last
 * only for a workout logged with weights (PhoneHubCoach.dc.html "Recent
 * workouts"). The whole row opens its summary.
 */
export function HistoryRow({ summary }: { summary: WorkoutSessionSummary }) {
  const row = recentRow(summary);
  return (
    <Link
      href={row.href}
      className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5 px-4 py-2.5 text-foreground no-underline transition-colors hover:bg-[#fbfaf8] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gold motion-reduce:transition-none"
    >
      <span
        aria-hidden
        className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-ok-bg text-ok"
      >
        <IconCheck size={15} strokeWidth={2.6} />
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className="truncate text-[14px] font-semibold">{row.title}</span>
        <span className="text-[12.5px] text-ink-2">{row.when}</span>
      </span>
      {row.volume === null ? null : (
        <span className="text-right font-display text-[13.5px] font-bold whitespace-nowrap">
          {row.volume}
        </span>
      )}
    </Link>
  );
}

/** The hub's last five finished workouts, and See all. */
export function RecentWorkouts({ recent }: { recent: readonly WorkoutSessionSummary[] }) {
  return (
    <section
      aria-labelledby="wk-recent-h"
      className="overflow-hidden rounded-[14px] border border-border bg-card"
    >
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
        <KickerHeading id="wk-recent-h">Recent workouts</KickerHeading>
        <Link
          href={HISTORY_HREF}
          className="relative text-[12.5px] font-semibold text-gold-deep no-underline after:absolute after:-inset-x-2 after:-inset-y-3 after:content-[''] hover:underline"
        >
          See all
        </Link>
      </div>
      <ul className="m-0 list-none p-0">
        {recent.map((summary) => (
          <li key={summary.id} className="border-t border-[rgba(26,26,26,0.06)]">
            <HistoryRow summary={summary} />
          </li>
        ))}
      </ul>
    </section>
  );
}
