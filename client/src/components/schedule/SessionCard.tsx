'use client';

import { Button } from '@/components/ui/button';
import { classLength, type ClassSession, type MyBooking } from '@/lib/classes';
import { bookingState, waitingCount, waitlistClosed } from '@/lib/schedule/bookingState';
import { cancelUntil, waitlistClosesLabel } from '@/lib/schedule/cancelCopy';
import { gymClock12 } from '@/lib/schedule/gymClock';
import { cn } from '@/lib/utils';
import { StatusBadge } from './StatusBadge';

interface SessionCardProps {
  session: ClassSession;
  /** The member's non-cancelled row for this class, if any. */
  booking: MyBooking | undefined;
  now: Date;
  busy: boolean;
  /**
   * Absent for a caller without `booking.create`, the key that both the book
   * and the cancel route check. The card then offers no Book, Join waitlist,
   * Take the free place or Cancel button, rather than one that fails with
   * "Missing required permission".
   */
  onBook?: (session: ClassSession) => void;
  onCancel?: (booking: MyBooking) => void;
  /**
   * The coach's own class (owner, 2026-10-23: coaches run their own). The
   * page passes these only for a class the caller coaches and may still
   * change; the server checks the same rule.
   */
  onEdit?: (session: ClassSession) => void;
  onCancelClass?: (session: ClassSession) => void;
}

/** A freed seat after the cutoff is not the queue's (owner, 2026-10-11). */
const FIRST_COME = 'A place that frees up now goes to whoever books it first.';

/** "3 waiting · <rest>", leaving out whichever half is missing. */
function line(...parts: (string | null)[]): string {
  return parts.filter((part): part is string => part !== null).join(' · ');
}

/** One class on the timetable, in exactly one of the states in spec §9.2. */
export function SessionCard({
  session,
  booking,
  now,
  busy,
  onBook,
  onCancel,
  onEdit,
  onCancelClass,
}: SessionCardProps) {
  const started = new Date(session.startsAt).getTime() <= now.getTime();
  const cancelled = session.cancelledAt !== null;
  const closed = waitlistClosed(session.startsAt, now);
  const view = booking === undefined ? null : bookingState(booking, now);
  const percent = Math.min(100, Math.round((session.bookedCount / session.capacity) * 100));
  // How long the queue is, never who is in it. Shown on full cards only: on a
  // class with free seats a waitlist is about to be served, not joined.
  const queue = waitingCount(session, now);
  const waiting = queue === null ? null : `${queue} waiting`;

  let badge: React.ReactNode = null;
  let footer: React.ReactNode = null;
  let action: React.ReactNode = null;

  const leaveButton = (held: MyBooking) =>
    onCancel === undefined ? null : (
      <Button variant="outline" size="sm" disabled={busy} onClick={() => onCancel(held)}>
        Leave waitlist
      </Button>
    );

  if (cancelled) {
    badge = <StatusBadge tone="danger">Class cancelled</StatusBadge>;
    footer = <span className="text-danger">{session.cancelReason}</span>;
  } else if (booking !== undefined && view !== null) {
    badge = <StatusBadge tone={view.tone}>{view.label}</StatusBadge>;

    if (booking.status === 'WAITLISTED' && !started) {
      if (!session.isFull) {
        // A free seat with this member still waiting: after the cutoff nobody
        // is moved in, so they take it themselves. The same POST as Book; the
        // server upgrades their own row, or explains why it cannot.
        footer = 'A place is free. It goes to whoever books it first.';
        action =
          onBook === undefined ? (
            leaveButton(booking)
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => onBook(session)}
                className="font-display uppercase tracking-[0.07em]"
              >
                Take the free place
              </Button>
              {leaveButton(booking)}
            </div>
          );
      } else {
        footer = line(waiting, closed ? FIRST_COME : waitlistClosesLabel(session.startsAt, now));
        action = leaveButton(booking);
      }
    } else if (view.canCancel) {
      footer = cancelUntil(session.startsAt, now);
      action =
        onCancel === undefined ? null : (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onCancel(booking)}>
            Cancel
          </Button>
        );
    } else if (booking.status === 'ATTENDED' || booking.status === 'NO_SHOW') {
      footer = 'You were registered for this class.';
    } else if (booking.status === 'WAITLISTED') {
      footer = "The waitlist didn't reach you.";
    } else {
      footer = 'This class has started.';
    }
  } else if (started) {
    badge = <StatusBadge tone="neutral">Started</StatusBadge>;
    footer = `Booking closed at ${gymClock12(session.startsAt)}`;
  } else if (session.isFull && closed) {
    // Nothing to join any more. Neutral, not warn: there is no action here,
    // only a seat that may free up and go to whoever books it first.
    badge = <StatusBadge tone="neutral">Full · waitlist closed</StatusBadge>;
    footer = line(waiting, FIRST_COME);
  } else if (session.isFull) {
    badge = <StatusBadge tone="warn">Full</StatusBadge>;
    footer =
      onBook === undefined
        ? line('This class is full.', waiting)
        : line(waiting, waitlistClosesLabel(session.startsAt, now));
    action =
      onBook === undefined ? null : (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onBook(session)}>
          Join waitlist
        </Button>
      );
  } else {
    if (session.seatsLeft <= 2)
      badge = <StatusBadge tone="warn">{session.seatsLeft} left</StatusBadge>;
    footer = `${session.seatsLeft} of ${session.capacity} places left`;
    action =
      onBook === undefined ? null : (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onBook(session)}
          className="font-display uppercase tracking-[0.07em]"
        >
          Book
        </Button>
      );
  }

  const mine = view?.live ?? false;
  // A started class is dimmed unless the member has a seat in it. A waitlist
  // place that never turned into a seat ("No place") is dimmed like any other
  // class they are not in.
  const dim = cancelled || (started && (booking === undefined || booking.status === 'WAITLISTED'));

  return (
    <article
      className={cn(
        // Phones: the time sits on its own line above the title, so the title
        // gets the card's full width. From `sm` it is a 4rem column again.
        'grid grid-cols-1 gap-2 rounded-xl border bg-card p-4 shadow-sm sm:grid-cols-[4rem_minmax(0,1fr)] sm:gap-3',
        mine ? 'border-gold' : 'border-transparent',
        dim && 'opacity-65',
      )}
    >
      <div className="flex items-baseline gap-2 whitespace-nowrap font-display text-[15px] font-semibold leading-tight sm:block">
        {gymClock12(session.startsAt)}
        <span className="font-sans text-xs font-normal text-ink-3 sm:block">
          {classLength(session.startsAt, session.endsAt)}
        </span>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="font-display text-[15px] font-semibold">{session.title}</h3>
          {badge}
        </div>
        <span className="text-[13px] text-ink-2">{session.coachName}</span>

        {cancelled ? null : (
          <div className="h-1 overflow-hidden rounded-full bg-paper-3" aria-hidden>
            <div
              className={cn('h-full rounded-full', session.isFull ? 'bg-warn' : 'bg-gold')}
              style={{ width: `${percent}%` }}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12.5px] text-ink-3">{footer}</span>
          {action}
        </div>

        {onEdit === undefined && onCancelClass === undefined ? null : (
          <div className="flex flex-wrap gap-2 border-t border-border pt-2">
            {onEdit === undefined ? null : (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onEdit(session)}>
                Edit
              </Button>
            )}
            {onCancelClass === undefined ? null : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onCancelClass(session)}
              >
                Cancel class
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
