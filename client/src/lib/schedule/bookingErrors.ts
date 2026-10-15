/**
 * What booking and cancelling say when they fail. It follows the discipline
 * of `lib/assistant/errors.ts` and `lib/workouts/errors.ts`: show the server's
 * words whenever it refused on purpose, and use this screen's own line only for
 * failures the server never put into words.
 *
 * Every refusal from the booking routes is member copy by design.
 * BOOKING_PLAN_REQUIRED is `bookingRefusalCopy`, BOOKING_WINDOW_NOT_OPEN names
 * the day booking opens, and WAITLIST_CLOSED says that the waitlist has closed.
 * What is NOT copy is a 500's bare "Internal server error", the throttler's
 * stock 429 sentence, and a dropped connection. The screen used to toast all
 * three verbatim.
 */

const SERVER_FAULT = 'That did not go through. Try again.';
const RATE_LIMITED = 'That is a lot at once. Give it a minute and try again.';
const OFFLINE = 'You look to be offline. Check your connection and try again.';

interface ApiErrorLike {
  message: string;
  status: number;
  code: string;
}

/**
 * Structural, not `instanceof ApiError`: importing lib/api would pull the
 * Supabase client into this module and make it untestable on its own.
 */
function isApiError(caught: unknown): caught is ApiErrorLike {
  return (
    caught instanceof Error &&
    caught.name === 'ApiError' &&
    typeof (caught as { status?: unknown }).status === 'number' &&
    typeof (caught as { code?: unknown }).code === 'string'
  );
}

/** The toast for a failed book, join, take or cancel. */
export function bookingErrorMessage(caught: unknown): string {
  if (isApiError(caught)) {
    if (caught.status === 429) return RATE_LIMITED;
    if (caught.status >= 500 || caught.code === 'INVALID_RESPONSE') return SERVER_FAULT;
    return caught.message;
  }
  // fetch() rejects with a TypeError when the request never reached the server.
  if (caught instanceof TypeError) return OFFLINE;
  return SERVER_FAULT;
}

/**
 * Whether the server turned the request down on its merits: a 4xx that it put
 * into words.
 *
 * That means the timetable on screen was out of date. The class filled, its
 * waitlist closed, or the member's plan stopped covering the day. So the page
 * reloads, the card stops offering what was just refused, and the banner or
 * note can say why. A 429, a server fault or a dropped connection says nothing
 * about the class, and a reload would only fail the same way.
 */
export function isBookingRefusal(caught: unknown): boolean {
  return (
    isApiError(caught) &&
    caught.status >= 400 &&
    caught.status < 500 &&
    caught.status !== 429 &&
    caught.code !== 'INVALID_RESPONSE'
  );
}
