import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from '@/lib/api';
import { fetchMyNotices, markNoticesSeen } from './api';

const mocked = vi.mocked(apiFetch);

beforeEach(() => {
  mocked.mockReset();
  mocked.mockResolvedValue({});
});

describe('member notices api', () => {
  it('reads one page of the member’s own notices', async () => {
    await fetchMyNotices(2);
    expect(mocked).toHaveBeenCalledWith('/me/notices?page=2&limit=10');
  });

  it('posts the mark as the newest notice shown — and nothing else', async () => {
    await markNoticesSeen('2026-10-11T03:00:00.000Z');
    expect(mocked).toHaveBeenCalledWith('/me/notices/seen', {
      method: 'POST',
      body: JSON.stringify({ upTo: '2026-10-11T03:00:00.000Z' }),
    });
  });

  /** The announcements feed has its own routes and stays exactly as it was. */
  it('never touches the announcements routes, and never names a member', async () => {
    await fetchMyNotices(1);
    await markNoticesSeen('2026-10-11T03:00:00.000Z');
    const paths = mocked.mock.calls.map((call) => call[0]);
    expect(paths.every((path) => path.startsWith('/me/notices'))).toBe(true);
    const bodies = mocked.mock.calls.map((call) => String(call[1]?.body ?? ''));
    expect(bodies.some((body) => /userId|memberId/.test(body))).toBe(false);
  });
});
