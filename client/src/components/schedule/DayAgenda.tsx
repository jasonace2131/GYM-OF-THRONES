'use client';

import { Button } from '@/components/ui/button';
import { classLength, type MyBooking } from '@/lib/classes';
import { bookingNote } from '@/lib/schedule/bookingNote';
import { bookingState } from '@/lib/schedule/bookingState';
import { cancelUntil } from '@/lib/schedule/cancelCopy';
import { gymClock12 } from '@/lib/schedule/gymClock';
import { shortDay } from '@/lib/schedule/labels';
import { BookingNoteLine } from './BookingNoteLine';
import { StatusBadge } from './StatusBadge';

interface DayAgendaProps {
  title: string;
  bookings: MyBooking[];
  now: Date;
  busyId: string | null;
  onCancel: (booking: MyBooking) => void;
  onOpen?: (booking: MyBooking) => void;
  /** Shown when `bookings` is empty. */
  empty?: React.ReactNode;
  /** Prefix each row with its day. For the List view, which spans many days. */
  showDate?: boolean;
}

export function DayAgenda({
  title,
  bookings,
  now,
  busyId,
  onCancel,
  onOpen,
  empty,
  showDate = false,
}: DayAgendaProps) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <h3 className="border-b border-border px-4 py-3 font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-3">
        {title}
      </h3>

      {bookings.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 py-7 text-center text-sm text-ink-3">
          {empty}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {bookings.map((item) => {
            const view = bookingState(item, now);
            const note = bookingNote(item, now);
            const { session } = item;
            const waitlisted = item.status === 'WAITLISTED';
            return (
              <li
                key={item.bookingId}
                className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-3"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 whitespace-nowrap font-display text-[15px] font-semibold leading-tight sm:block">
                  {showDate ? (
                    <span className="text-[11px] uppercase tracking-[0.08em] text-ink-3 sm:block">
                      {shortDay(session.businessDate)}
                    </span>
                  ) : null}
                  {gymClock12(session.startsAt)}
                  <span className="font-sans text-xs font-normal text-ink-3 sm:block">
                    {classLength(session.startsAt, session.endsAt)}
                  </span>
                </div>

                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {onOpen ? (
                      <button
                        type="button"
                        onClick={() => onOpen(item)}
                        className="text-left font-display text-[15px] font-semibold hover:underline"
                      >
                        {session.title}
                      </button>
                    ) : (
                      <span className="font-display text-[15px] font-semibold">
                        {session.title}
                      </span>
                    )}
                    <StatusBadge tone={view.tone}>{view.label}</StatusBadge>
                  </div>
                  <span className="text-[13px] text-ink-2">{session.coachName}</span>

                  {note === null ? null : <BookingNoteLine note={note} />}

                  {view.canCancel ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <span className="text-[12.5px] text-ink-3">
                        {cancelUntil(session.startsAt, now, waitlisted ? 'Leave' : 'Cancel')}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyId === session.id}
                        onClick={() => onCancel(item)}
                      >
                        {waitlisted ? 'Leave waitlist' : 'Cancel'}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
