import Link from 'next/link';
import { CardHead, EmptyState } from '@/components/portal/ui';
import { StatusBadge } from '@/components/schedule/StatusBadge';
import { classLength } from '@/lib/classes';
import { waitlistLine } from '@/lib/dashboard/dashboardView';
import type { Section } from '@/lib/dashboard/loadDashboard';
import { bookingState } from '@/lib/schedule/bookingState';
import { cancelUntil } from '@/lib/schedule/cancelCopy';
import { gymClock12 } from '@/lib/schedule/gymClock';
import { shortDay } from '@/lib/schedule/labels';
import type { UpcomingSummary } from '@/lib/schedule/upcoming';
import { cn } from '@/lib/utils';

/** The member's next few live bookings — or the way to make one. */
export function UpcomingCard({
  bookings,
  now,
  emptyHint,
  onRetry,
  className,
}: {
  bookings: Section<UpcomingSummary>;
  now: Date;
  /** Under "Nothing booked yet": whether, and how far ahead, they can book (`upcomingEmptyHint`). */
  emptyHint: string;
  onRetry: () => void;
  className?: string;
}) {
  const waitlisted = bookings.ok ? waitlistLine(bookings.data.waitlisted) : null;

  return (
    <section aria-labelledby="dash-upcoming" className={cn('p-card overflow-hidden', className)}>
      <CardHead
        as="h2"
        id="dash-upcoming"
        title="Upcoming classes"
        action={
          <Link
            href="/portal/book"
            className="-my-2 inline-flex min-h-9 items-center text-[12.5px] font-semibold text-gold-deep hover:text-gold-deep hover:underline"
          >
            My bookings
          </Link>
        }
      />

      {!bookings.ok ? (
        <EmptyState
          title="Couldn't load your classes"
          hint="Check your connection, then try again."
          action={
            <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={onRetry}>
              Try again
            </button>
          }
        />
      ) : bookings.data.upcoming.length === 0 ? (
        <EmptyState
          title="Nothing booked yet"
          hint={emptyHint}
          action={
            <Link href="/portal/schedule" className="p-btn p-btn-ghost p-btn-sm">
              Browse classes
            </Link>
          }
        />
      ) : (
        <>
          <ul className="m-0 list-none p-0">
            {bookings.data.upcoming.map((item) => {
              const view = bookingState(item, now);
              return (
                <li
                  key={item.bookingId}
                  className="flex items-center gap-3 border-b border-border px-[18px] py-[13px] last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-foreground">
                      {item.session.title}
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                      {shortDay(item.session.businessDate)} · {gymClock12(item.session.startsAt)} ·{' '}
                      {item.session.coachName} ·{' '}
                      {classLength(item.session.startsAt, item.session.endsAt)}
                    </div>
                    {view.canCancel ? (
                      <div className="mt-0.5 text-[11.5px] text-ink-3">
                        {cancelUntil(
                          item.session.startsAt,
                          now,
                          item.status === 'WAITLISTED' ? 'Leave' : 'Cancel',
                        )}
                      </div>
                    ) : null}
                  </div>
                  <StatusBadge tone={view.tone}>{view.label}</StatusBadge>
                </li>
              );
            })}
          </ul>
          {waitlisted === null ? null : (
            <p className="m-0 border-t border-border px-[18px] py-2.5 text-[12px] text-ink-3">
              {waitlisted}
            </p>
          )}
        </>
      )}
    </section>
  );
}
