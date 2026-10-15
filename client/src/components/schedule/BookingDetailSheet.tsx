'use client';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { MyBooking } from '@/lib/classes';
import { bookingNote } from '@/lib/schedule/bookingNote';
import { bookingState, waitingCount } from '@/lib/schedule/bookingState';
import { cancelUntil } from '@/lib/schedule/cancelCopy';
import { gymClock12 } from '@/lib/schedule/gymClock';
import { longDay } from '@/lib/schedule/labels';
import { cn } from '@/lib/utils';
import { BookingNoteLine } from './BookingNoteLine';
import { StatusBadge } from './StatusBadge';

interface BookingDetailSheetProps {
  booking: MyBooking | null;
  now: Date;
  /** Bottom on a phone, right on anything wider. */
  side: 'bottom' | 'right';
  onClose: () => void;
  onCancel: (booking: MyBooking) => void;
}

export function BookingDetailSheet({
  booking,
  now,
  side,
  onClose,
  onCancel,
}: BookingDetailSheetProps) {
  const view = booking === null ? null : bookingState(booking, now);
  // The same line My bookings shows under the row: the gym's reason for a
  // cancelled class or a removal, or what happens next on a waitlist.
  const note = booking === null ? null : bookingNote(booking, now);
  const waitlisted = booking?.status === 'WAITLISTED';
  // Not once the class has started (its waitlist rows read "No place"), and
  // not on a class the gym called off: the timetable card's rule.
  const waiting = booking === null ? null : waitingCount(booking.session, now);

  return (
    <Sheet
      open={booking !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side={side}
        className={cn(side === 'bottom' ? 'rounded-t-2xl' : 'w-[380px] sm:max-w-[380px]')}
      >
        {booking === null || view === null ? null : (
          <>
            <SheetHeader>
              <SheetTitle className="font-display text-xl">{booking.session.title}</SheetTitle>
              <SheetDescription>
                {longDay(booking.session.businessDate)}, {gymClock12(booking.session.startsAt)}–
                {gymClock12(booking.session.endsAt)}
              </SheetDescription>
            </SheetHeader>

            <div className="grid gap-3 px-4">
              <div>
                <StatusBadge tone={view.tone}>{view.label}</StatusBadge>
              </div>
              <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-ink-3">Coach</dt>
                <dd>{booking.session.coachName}</dd>
                <dt className="text-ink-3">Places</dt>
                <dd>
                  {booking.session.seatsLeft} of {booking.session.capacity} left
                  {waiting === null ? '' : ` · ${waiting} waiting`}
                </dd>
              </dl>
              {note === null ? null : <BookingNoteLine note={note} className="text-[13px]" />}
              {view.canCancel ? (
                <p className="m-0 text-[13px] text-ink-3">
                  {cancelUntil(booking.session.startsAt, now, waitlisted ? 'Leave' : 'Cancel')}.
                </p>
              ) : null}
            </div>

            <SheetFooter className="flex-row gap-2">
              {view.canCancel ? (
                <Button variant="outline" onClick={() => onCancel(booking)}>
                  {waitlisted ? 'Leave waitlist' : 'Cancel booking'}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
