import { DenialReason, bookingRefusalCopy, type MyBookingWindowWire } from '@got/shared';
import { shortDay } from './labels';

/**
 * What the timetable says about a member's booking window, from
 * `GET /me/booking-window`.
 *
 * The server is the authority on every one of these. The screen only explains
 * the window BEFORE the member taps Book, so that a refusal is not the first
 * they hear of it. Every booking is still checked again on the server, on the
 * class's own day.
 *
 * (The parameter is `ahead`, never `window`, so it cannot shadow the browser
 * global.)
 */

export interface WindowBanner {
  /** The server's member copy (`bookingRefusalCopy`), shown verbatim. */
  message: string;
  /** A way to fix it on their own Subscription page. Null for an account note. */
  action: { label: string; href: string } | null;
}

const SUBSCRIPTION = '/portal/subscription';

/**
 * The same buttons the dashboard's status band offers for these reasons
 * (`membershipStatusView`), so the two screens send a member the same way.
 * The account reasons have none: the copy says "talk to the desk", and the
 * Subscription page cannot lift an account note.
 */
const ACTION_LABEL: Partial<Record<DenialReason, string>> = {
  [DenialReason.NO_MEMBERSHIP]: 'Choose a plan',
  [DenialReason.MEMBERSHIP_EXPIRED]: 'Renew',
  [DenialReason.MEMBERSHIP_CANCELLED]: 'Choose a plan',
  [DenialReason.MEMBERSHIP_FROZEN]: 'View my plan',
};

/** The banner over the timetable when the member's plan does not cover today. */
export function windowBanner(ahead: MyBookingWindowWire | null): WindowBanner | null {
  if (ahead === null || ahead.eligibleToday) return null;
  const message =
    ahead.message ?? (ahead.reason === null ? null : bookingRefusalCopy(ahead.reason, null));
  if (message === null) return null;
  const label = ahead.reason === null ? undefined : ACTION_LABEL[ahead.reason];
  return { message, action: label === undefined ? null : { label, href: SUBSCRIPTION } };
}

/**
 * A quiet note when the plan ends inside the window: the strip offers days
 * that the plan does not cover, and booking one of them is refused. Null when
 * the plan covers the whole window, when there is no plan, or when it has
 * already ended (the banner says that).
 *
 * Civil dates compare as strings: yyyy-mm-dd sorts in date order.
 */
export function windowCoverageNote(
  ahead: MyBookingWindowWire | null,
  today: string,
): string | null {
  if (ahead === null || ahead.planCoversUntil === null) return null;
  const until = ahead.planCoversUntil;
  if (until < today || until >= ahead.lastBookableDay) return null;
  return `Your plan covers classes up to ${shortDay(until)}. Classes after that need a renewal.`;
}

const WEEKS: Readonly<Record<number, string>> = {
  1: 'week',
  2: 'two weeks',
  3: 'three weeks',
  4: 'four weeks',
};

/** "two weeks" for 14 days, "three weeks" for 21, otherwise "10 days". */
export function windowSpan(days: number): string {
  return (Number.isInteger(days / 7) ? WEEKS[days / 7] : undefined) ?? `${days} days`;
}
