import Link from 'next/link';
import type { BookingNote, BookingNoteTone } from '@/lib/schedule/bookingNote';
import { cn } from '@/lib/utils';

const TONE: Record<BookingNoteTone, string> = {
  danger: 'text-danger',
  ok: 'text-ok',
  muted: 'text-ink-2',
};

/**
 * The line under a booking (`bookingNote`), with its next step as a link when
 * it has one. Used by My bookings' agenda and the booking detail sheet, so the
 * two cannot word the same booking differently.
 */
export function BookingNoteLine({ note, className }: { note: BookingNote; className?: string }) {
  return (
    <span className={cn('text-[12.5px]', TONE[note.tone], className)}>
      {note.text}
      {note.link === null ? null : (
        <>
          {' '}
          <Link href={note.link.href} className="font-semibold text-gold-deep hover:underline">
            {note.link.label}
          </Link>
        </>
      )}
    </span>
  );
}
