import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from './api';
import {
  classesApi,
  normaliseBooking,
  normaliseSession,
  type OlderClassSession,
  type OlderMyBooking,
} from './classes';
import { booking, session } from './schedule/fixtures';

/**
 * The deploy window: Vercel serves the new client minutes before Render serves
 * the new API, and the new screens must read the OLD replies without printing
 * "#undefined" or "NaN". These are the replies that API sends.
 */
function without<T extends object, K extends keyof T>(value: T, keys: K[]): Omit<T, K> {
  const copy: Partial<T> = { ...value };
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}

function olderSession(): OlderClassSession {
  return without(session(), ['waitlistCount']);
}

function olderBooking(status: OlderMyBooking['status']): OlderMyBooking {
  const rest = without(booking(status), [
    'waitlistPosition',
    'cancelledBy',
    'removalReason',
    'addedByStaff',
  ]);
  return { ...rest, session: olderSession() };
}

describe('normaliseSession', () => {
  it('counts nobody waiting when an older API leaves the count out', () => {
    expect(normaliseSession(olderSession()).waitlistCount).toBe(0);
  });

  it("keeps the new API's count", () => {
    expect(normaliseSession(session({ waitlistCount: 3 })).waitlistCount).toBe(3);
  });
});

describe('normaliseBooking', () => {
  it('fills the fields an older API leaves out with values that claim nothing', () => {
    const filled = normaliseBooking(olderBooking('WAITLISTED'));
    expect(filled).toMatchObject({
      waitlistPosition: null,
      cancelledBy: null,
      removalReason: null,
      addedByStaff: false,
    });
    expect(filled.session.waitlistCount).toBe(0);
  });

  /** The old API has no route for staff to take anybody out of a class. */
  it("reads an older API's cancellation as the member's own", () => {
    expect(normaliseBooking(olderBooking('CANCELLED')).cancelledBy).toBe('MEMBER');
  });

  it("keeps every field the new API sends, a gym removal's included", () => {
    const removed = booking('CANCELLED', {}, 'b1', {
      cancelledBy: 'GYM',
      removalReason: 'Class moved',
    });
    expect(normaliseBooking(removed)).toEqual(removed);

    const queued = booking('WAITLISTED', { waitlistCount: 4 }, 'b2', { waitlistPosition: 3 });
    expect(normaliseBooking(queued)).toEqual(queued);
  });
});

describe('classesApi — every reply is normalised', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('sessions()', async () => {
    vi.mocked(apiFetch).mockResolvedValue([olderSession()]);
    const [first] = await classesApi.sessions({ from: '2026-09-16' });
    expect(apiFetch).toHaveBeenCalledWith('/class-sessions?from=2026-09-16');
    expect(first?.waitlistCount).toBe(0);
  });

  it('myBookings()', async () => {
    vi.mocked(apiFetch).mockResolvedValue([olderBooking('WAITLISTED')]);
    const [first] = await classesApi.myBookings();
    expect(apiFetch).toHaveBeenCalledWith('/me/bookings');
    expect(first?.waitlistPosition).toBeNull();
    expect(first?.session.waitlistCount).toBe(0);
  });

  it('book()', async () => {
    vi.mocked(apiFetch).mockResolvedValue(olderBooking('WAITLISTED'));
    const result = await classesApi.book('s1');
    expect(apiFetch).toHaveBeenCalledWith('/class-sessions/s1/bookings', { method: 'POST' });
    expect(result.waitlistPosition).toBeNull();
  });

  it('cancel()', async () => {
    vi.mocked(apiFetch).mockResolvedValue(olderBooking('CANCELLED'));
    const result = await classesApi.cancel('s1');
    expect(apiFetch).toHaveBeenCalledWith('/class-sessions/s1/bookings', { method: 'DELETE' });
    expect(result).toMatchObject({ cancelledBy: 'MEMBER', addedByStaff: false });
  });
});
