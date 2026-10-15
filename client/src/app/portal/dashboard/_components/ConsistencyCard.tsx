import Link from 'next/link';
import { ConsistencyHeatmap } from '@/components/portal/ConsistencyHeatmap';
import { CardHead, EmptyState } from '@/components/portal/ui';
import type { CheckInSection, Section } from '@/lib/dashboard/loadDashboard';
import type { StatusCta } from '@/lib/dashboard/membershipStatus';
import { cn } from '@/lib/utils';

/**
 * Twenty-six weeks of visits, with the streak — or its own way back from a
 * failure. `cta` is the status band's primary action (Check in, or Choose a
 * plan for somebody the door would refuse), offered when there are no visits.
 */
export function ConsistencyCard({
  checkIns,
  cta,
  onRetry,
  className,
}: {
  checkIns: Section<CheckInSection>;
  cta: StatusCta | null;
  onRetry: () => void;
  className?: string;
}) {
  // The CURRENT streak already sits in the status band; the header carries the
  // one number that band does not — the member's best.
  const best = checkIns.ok ? checkIns.data.summary.longestStreakWeeks : 0;

  return (
    <section aria-labelledby="dash-consistency" className={cn('p-card overflow-hidden', className)}>
      <CardHead
        as="h2"
        id="dash-consistency"
        title="Your consistency"
        action={
          best > 0 ? (
            <span className="text-[12.5px] text-muted-foreground">
              Best streak{' '}
              <span className="font-semibold text-gold-deep">
                {best} {best === 1 ? 'week' : 'weeks'}
              </span>
            </span>
          ) : null
        }
      />

      {!checkIns.ok ? (
        <EmptyState
          title="Couldn't load your visits"
          hint="Check your connection, then try again."
          action={
            <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={onRetry}>
              Try again
            </button>
          }
        />
      ) : (
        <div className="p-card-pad">
          <ConsistencyHeatmap days={checkIns.data.heatmap} />
          {checkIns.data.summary.allTime === 0 ? (
            <p className="m-0 mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-ink-2">
              No visits yet — your first check-in lights up a square.
              {cta !== null ? (
                <Link
                  href={cta.href}
                  className="font-semibold text-gold-deep hover:text-gold-deep hover:underline"
                >
                  {cta.label}
                </Link>
              ) : null}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
