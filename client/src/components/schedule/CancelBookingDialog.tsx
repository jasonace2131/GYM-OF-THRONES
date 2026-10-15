'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { MyBooking } from '@/lib/classes';
import { cancelConsequence } from '@/lib/schedule/cancelCopy';
import { gymClock12 } from '@/lib/schedule/gymClock';
import { shortDay } from '@/lib/schedule/labels';

interface CancelBookingDialogProps {
  /** The booking being cancelled; null closes the dialog. */
  booking: MyBooking | null;
  /**
   * The page's clock. What happens to the freed place depends on it: before
   * the waitlist closes it goes to the next person waiting, and after that to
   * whoever books it first.
   */
  now: Date;
  busy: boolean;
  onConfirm: (booking: MyBooking) => void;
  onClose: () => void;
}

export function CancelBookingDialog({
  booking,
  now,
  busy,
  onConfirm,
  onClose,
}: CancelBookingDialogProps) {
  const waitlisted = booking?.status === 'WAITLISTED';

  return (
    <AlertDialog
      open={booking !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        {booking === null ? null : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="font-display">
                {waitlisted ? 'Leave the waitlist?' : `Cancel ${booking.session.title}?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {shortDay(booking.session.businessDate)}, {gymClock12(booking.session.startsAt)}{' '}
                with {booking.session.coachName}. {cancelConsequence(booking, now)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Keep my place</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                variant="destructive"
                onClick={(event) => {
                  // Keep the dialog open until the request settles.
                  event.preventDefault();
                  onConfirm(booking);
                }}
              >
                {waitlisted ? 'Leave waitlist' : 'Cancel booking'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
