import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from './api';
import { coachApi } from './coachApi';

const MEMBER = 'm-1';
const BASE = `/me/coaching/members/${MEMBER}`;

/**
 * Thin-wrapper contract tests, the same shape as `adminApi.test.ts`: each
 * asserts only the path, method and body handed to `apiFetch`. A wrapper that
 * sent a coach's write to `/me/measurements` — the member's retired route —
 * would 403 in production with nothing else to catch it.
 */
describe('coachApi — coach-recorded progress', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
  });

  it('memberProgress() reads the drill-down', async () => {
    await coachApi.memberProgress(MEMBER);
    expect(apiFetch).toHaveBeenCalledWith(`${BASE}/progress`);
  });

  it('recordMeasurement() posts the reading under the member', async () => {
    const body = { businessDate: '2026-09-24', weightGrams: 72_400 };
    await coachApi.recordMeasurement(MEMBER, body);
    expect(apiFetch).toHaveBeenCalledWith(`${BASE}/measurements`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('updateMeasurement() patches one day, nulls included', async () => {
    await coachApi.updateMeasurement(MEMBER, 'd-1', { heightMm: null });
    expect(apiFetch).toHaveBeenCalledWith(`${BASE}/measurements/d-1`, {
      method: 'PATCH',
      body: JSON.stringify({ heightMm: null }),
    });
  });

  it('deleteMeasurement() deletes one day', async () => {
    await coachApi.deleteMeasurement(MEMBER, 'd-1');
    expect(apiFetch).toHaveBeenCalledWith(`${BASE}/measurements/d-1`, { method: 'DELETE' });
  });

  it('createGoal() posts the goal (apiFetch adds the Idempotency-Key)', async () => {
    const body = { name: 'Bench', unit: 'kg', startHundredths: 6000, targetHundredths: 10_000 };
    await coachApi.createGoal(MEMBER, body);
    expect(apiFetch).toHaveBeenCalledWith(`${BASE}/goals`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('updateGoal() patches one goal', async () => {
    await coachApi.updateGoal(MEMBER, 'g-1', { achieved: true });
    expect(apiFetch).toHaveBeenCalledWith(`${BASE}/goals/g-1`, {
      method: 'PATCH',
      body: JSON.stringify({ achieved: true }),
    });
  });

  it('deleteGoal() deletes one goal', async () => {
    await coachApi.deleteGoal(MEMBER, 'g-1');
    expect(apiFetch).toHaveBeenCalledWith(`${BASE}/goals/g-1`, { method: 'DELETE' });
  });

  it('encodes the member id rather than trusting the URL it came from', async () => {
    await coachApi.memberProgress('a/../b');
    expect(apiFetch).toHaveBeenCalledWith('/me/coaching/members/a%2F..%2Fb/progress');
  });
});

/**
 * The coach's register (2026-10-11): any class whose register has opened, past
 * days included, so the schedule's range and both register calls are pinned.
 */
describe('coachApi — schedule and the register', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
  });

  it('schedule() forwards the range', async () => {
    await coachApi.schedule({ from: '2026-10-05', to: '2026-10-11' });
    expect(apiFetch).toHaveBeenCalledWith('/me/coaching/schedule?from=2026-10-05&to=2026-10-11');
  });

  it('schedule() sends a bare path for "this week"', async () => {
    await coachApi.schedule();
    expect(apiFetch).toHaveBeenCalledWith('/me/coaching/schedule');
  });

  it('register() reads the same register route the console reads', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce([]);
    await coachApi.register('s1');
    expect(apiFetch).toHaveBeenCalledWith('/class-sessions/s1/register');
  });

  /**
   * The deploy window: Vercel goes live before Render, and the API the new
   * dashboard briefly reads sends rows with no marker and no queue place.
   */
  it('register() gives an old row null markers, no queue place and no desk add', async () => {
    const member = { firstName: 'Maria', lastName: 'Santos', memberCode: null };
    vi.mocked(apiFetch).mockResolvedValueOnce([{ bookingId: 'b1', status: 'BOOKED', member }]);
    expect(await coachApi.register('s1')).toEqual([
      {
        bookingId: 'b1',
        status: 'BOOKED',
        bookedAt: '',
        waitlistPosition: null,
        addedByStaff: false,
        markedAt: null,
        markedBy: null,
        member,
      },
    ]);
  });

  /** The staff route: `booking.attend`, not the path segment, decides who may call it. */
  it('markAttendance() posts the mark to the staff route', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ bookingId: 'b1', status: 'ATTENDED' });
    await coachApi.markAttendance('b1', true);
    expect(apiFetch).toHaveBeenCalledWith('/admin/class-sessions/bookings/b1/attendance', {
      method: 'POST',
      body: JSON.stringify({ attended: true }),
    });
  });

  /** The row is patched from this answer, so a missing marker must be null, not undefined. */
  it('markAttendance() reads an old answer as a mark with no marker', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ bookingId: 'b1', status: 'ATTENDED' });
    expect(await coachApi.markAttendance('b1', true)).toEqual({
      bookingId: 'b1',
      status: 'ATTENDED',
      markedAt: null,
      markedBy: null,
    });
  });
});

// Staff & Access: the coach's own profile, read-only on their dashboard.
describe('coachApi — own profile', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
  });

  it('ownProfile() reads /coaches/:id/profile — coach.read at OWN reaches only their own', async () => {
    await coachApi.ownProfile('c/1');
    expect(apiFetch).toHaveBeenCalledWith('/coaches/c%2F1/profile');
  });
});
