import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from '@/lib/api';
import { at, booking } from '@/lib/schedule/fixtures';
import { loadDashboard } from './loadDashboard';

const mocked = vi.mocked(apiFetch);
const NOW = at('2026-09-24', '09:00');

const OVERVIEW = {
  userId: 'u1',
  memberCode: 'K7QX2M',
  firstName: 'Client',
  lastName: 'Test',
  status: 'ACTIVE',
  membership: null,
  verdict: { decision: 'DENY', denialReason: 'NO_MEMBERSHIP', allowReason: null },
  guestPassesRemaining: 0,
  lastPayment: null,
};

const SUMMARY = {
  thisMonth: 3,
  allTime: 41,
  avgPerWeek: 1.4,
  currentStreakWeeks: 3,
  longestStreakWeeks: 5,
  days: [{ date: '2026-09-22', count: 1 }],
};

const SPIN = booking('BOOKED', {
  title: 'Spin',
  startsAt: at('2026-09-25', '07:00').toISOString(),
  businessDate: '2026-09-25',
});

function route(fail: Partial<Record<'overview' | 'summary' | 'bookings', boolean>> = {}) {
  mocked.mockImplementation((path: string) => {
    if (path === '/me/overview') {
      return fail.overview ? Promise.reject(new Error('down')) : Promise.resolve(OVERVIEW);
    }
    if (path === '/me/check-ins/summary') {
      return fail.summary ? Promise.reject(new Error('down')) : Promise.resolve(SUMMARY);
    }
    if (path.startsWith('/me/bookings')) {
      return fail.bookings ? Promise.reject(new Error('down')) : Promise.resolve([SPIN]);
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

beforeEach(() => {
  mocked.mockReset();
});

describe('loadDashboard', () => {
  /**
   * The screen this replaces fetched /me AND /me/membership for a name and a
   * plan that /me/overview returns together, plus the admin-ordered
   * /announcements list the bell's feed now carries.
   */
  it('makes exactly three calls — no /me, no /announcements', async () => {
    route();
    await loadDashboard(NOW);

    const paths = mocked.mock.calls.map((call) => call[0]);
    expect(paths).toHaveLength(3);
    expect(paths).toContain('/me/overview');
    expect(paths).toContain('/me/check-ins/summary');
    // Exactly 14 gym days, today included: the 24th to the 7th. The tile says
    // "next 14 days", and the old today + 14 fetch was really 15.
    expect(paths).toContain('/me/bookings?from=2026-09-24&to=2026-10-07');
    expect(paths).not.toContain('/me');
    expect(paths.some((path) => path.startsWith('/announcements'))).toBe(false);
  });

  it('returns the overview and both sections', async () => {
    route();
    const data = await loadDashboard(NOW);

    expect(data.overview.firstName).toBe('Client');
    expect(data.checkIns.ok && data.checkIns.data.summary.allTime).toBe(41);
    expect(data.checkIns.ok && data.checkIns.data.heatmap).toHaveLength(26 * 7);
    expect(data.bookings.ok && data.bookings.data.next?.session.title).toBe('Spin');
    expect(data.bookings.ok && data.bookings.data.booked).toBe(1);
    expect(data.bookings.ok && data.bookings.data.waitlisted).toBe(0);
  });

  /** Without the overview there is no name and no plan — the page errors. */
  it('rejects when the overview fails', async () => {
    route({ overview: true });
    await expect(loadDashboard(NOW)).rejects.toThrow('down');
  });

  it('fails only its own section when the summary fails', async () => {
    route({ summary: true });
    const data = await loadDashboard(NOW);
    expect(data.checkIns.ok).toBe(false);
    expect(data.bookings.ok).toBe(true);
    expect(data.overview.firstName).toBe('Client');
  });

  it('fails only its own section when bookings fail', async () => {
    route({ bookings: true });
    const data = await loadDashboard(NOW);
    expect(data.bookings.ok).toBe(false);
    expect(data.checkIns.ok).toBe(true);
  });
});
