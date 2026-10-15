import { registerOpensAt, waitlistClosesAt } from '@got/shared';
import type { MyBooking } from '@/lib/classes';
import { waitlistClosed } from './bookingState';
import { gymClock12, gymParts, shiftDay } from './gymClock';
import { shortDay } from './labels';

export function relativeDay(day: string, today: string): string {
  if (day === today) return 'today';
  if (day === shiftDay(today, 1)) return 'tomorrow';
  return shortDay(day);
}

/** "5:30 PM", with its day only when that is not today: "6:30 AM tomorrow". */
function clockFrom(instant: Date, now: Date): string {
  const day = gymParts(instant).date;
  const today = gymParts(now).date;
  return `${gymClock12(instant)}${day === today ? '' : ` ${relativeDay(day, today)}`}`;
}

/**
 * "Cancel until 7:00 AM tomorrow". The server refuses from the start instant.
 *
 * A waitlist place is left, not cancelled, and the button beside this line
 * says "Leave waitlist", so the line says "Leave until …" for one.
 */
export function cancelUntil(
  startsAt: string,
  now: Date,
  verb: 'Cancel' | 'Leave' = 'Cancel',
): string {
  return `${verb} until ${gymClock12(startsAt)} ${relativeDay(gymParts(startsAt).date, gymParts(now).date)}`;
}

/** "Register opens 5:30 PM" (today) or "Register opens 6:30 AM tomorrow". */
export function registerOpensLabel(startsAt: string, now: Date): string {
  return `Register opens ${clockFrom(registerOpensAt(startsAt), now)}`;
}

/**
 * When the waitlist closes, read on the gym's clock: "4:00 PM" (today),
 * "4:00 AM tomorrow" or "4:00 PM Wed 16 Sep". Written for a waitlist that is
 * still open. Once it has closed, say that instead (`waitlistClosed`).
 */
export function waitlistClosesTime(startsAt: string, now: Date): string {
  return clockFrom(waitlistClosesAt(startsAt), now);
}

/** "Waitlist closes 4:00 PM" (today) or "Waitlist closes 4:00 PM tomorrow", like the register's. */
export function waitlistClosesLabel(startsAt: string, now: Date): string {
  return `Waitlist closes ${waitlistClosesTime(startsAt, now)}`;
}

/**
 * The cancel dialog's second sentence: what happens to the place the member
 * is giving up.
 *
 * Until the waitlist closes, a freed seat goes to the next person waiting, but
 * only when somebody is waiting. From the cutoff on, nobody is moved in, so the
 * seat goes to whoever books it first (owner, 2026-10-11), and a waitlist place
 * no longer has a queue position to lose.
 *
 * A position compared `== null` here and in `waitlistJoinedCopy`: an API one
 * release behind sends none at all (see `bookingState`).
 */
export function cancelConsequence(
  booking: Pick<MyBooking, 'status' | 'waitlistPosition' | 'session'>,
  now: Date,
): string {
  const closed = waitlistClosed(booking.session.startsAt, now);

  if (booking.status === 'WAITLISTED') {
    if (closed) return 'You come off the waitlist for this class.';
    return booking.waitlistPosition == null
      ? 'You lose your place in the queue.'
      : `You lose your place in the queue. You're #${booking.waitlistPosition}.`;
  }
  if (closed) return 'The waitlist has closed, so your place goes to whoever books it first.';
  return booking.session.waitlistCount > 0
    ? 'Your place goes to the next person on the waitlist.'
    : 'Your place opens up for someone else to book.';
}

/**
 * The toast after joining a waitlist: the place in the queue, and the time
 * after which nobody is moved in.
 */
export function waitlistJoinedCopy(
  booking: Pick<MyBooking, 'waitlistPosition' | 'session'>,
  now: Date,
): { title: string; description: string } {
  const { title, startsAt } = booking.session;
  return {
    title:
      booking.waitlistPosition == null
        ? `On the waitlist for ${title}`
        : `You're #${booking.waitlistPosition} on the waitlist for ${title}`,
    description: `If a place opens up before ${waitlistClosesTime(startsAt, now)}, you move in automatically.`,
  };
}
