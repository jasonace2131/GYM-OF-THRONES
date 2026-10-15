import { describe, expect, it } from 'vitest';
import { bookingErrorMessage, isBookingRefusal } from './bookingErrors';

/** The shape `apiFetch` throws, without importing lib/api (it pulls in Supabase). */
class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const refusal = (code: string, message: string, status = 422) =>
  new FakeApiError(message, status, code);

describe('bookingErrorMessage', () => {
  it("shows the server's words for a refusal it put into words", () => {
    const plan = refusal(
      'BOOKING_PLAN_REQUIRED',
      'Your plan ends 16 Oct, before this class. Renew to book it.',
    );
    expect(bookingErrorMessage(plan)).toBe(
      'Your plan ends 16 Oct, before this class. Renew to book it.',
    );
    expect(
      bookingErrorMessage(refusal('WAITLIST_CLOSED', 'The waitlist for Yoga has closed.')),
    ).toBe('The waitlist for Yoga has closed.');
    expect(bookingErrorMessage(refusal('ALREADY_BOOKED', "You're already booked.", 409))).toBe(
      "You're already booked.",
    );
  });

  /** These used to reach the member verbatim: "Internal server error", the throttler's stock line. */
  it('writes its own line for what the server never put into words', () => {
    expect(
      bookingErrorMessage(refusal('INTERNAL_SERVER_ERROR', 'Internal server error', 500)),
    ).toBe('That did not go through. Try again.');
    expect(
      bookingErrorMessage(refusal('HTTP_429', 'ThrottlerException: Too Many Requests', 429)),
    ).toBe('That is a lot at once. Give it a minute and try again.');
    expect(
      bookingErrorMessage(refusal('INVALID_RESPONSE', 'Request returned a non-JSON response', 200)),
    ).toBe('That did not go through. Try again.');
  });

  it('tells a dropped connection apart from anything else', () => {
    expect(bookingErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'You look to be offline. Check your connection and try again.',
    );
    expect(bookingErrorMessage(new Error('boom'))).toBe('That did not go through. Try again.');
  });
});

describe('isBookingRefusal — reload after this?', () => {
  it('is true for a refusal on the merits: the page was out of date', () => {
    expect(isBookingRefusal(refusal('BOOKING_PLAN_REQUIRED', 'x'))).toBe(true);
    expect(isBookingRefusal(refusal('BOOKING_WINDOW_NOT_OPEN', 'x'))).toBe(true);
    expect(isBookingRefusal(refusal('WAITLIST_CLOSED', 'x'))).toBe(true);
    expect(isBookingRefusal(refusal('ALREADY_BOOKED', 'x', 409))).toBe(true);
    expect(isBookingRefusal(refusal('CLASS_NOT_FOUND', 'x', 404))).toBe(true);
  });

  it('is false when the failure says nothing about the class', () => {
    expect(isBookingRefusal(refusal('HTTP_429', 'x', 429))).toBe(false);
    expect(isBookingRefusal(refusal('INTERNAL_SERVER_ERROR', 'x', 500))).toBe(false);
    expect(isBookingRefusal(refusal('INVALID_RESPONSE', 'x', 404))).toBe(false);
    expect(isBookingRefusal(new TypeError('Failed to fetch'))).toBe(false);
    expect(isBookingRefusal(new Error('boom'))).toBe(false);
  });
});
