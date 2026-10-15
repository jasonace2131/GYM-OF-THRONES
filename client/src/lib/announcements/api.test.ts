import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from '@/lib/api';
import { fetchAnnouncement, fetchMemberFeed, markAnnouncementsSeen } from './api';

const mocked = vi.mocked(apiFetch);

beforeEach(() => {
  mocked.mockReset();
  mocked.mockResolvedValue({});
});

describe('announcements api', () => {
  it('reads one page of the member feed', async () => {
    await fetchMemberFeed(2);
    expect(mocked).toHaveBeenCalledWith('/me/announcements?page=2&limit=10');
  });

  it('posts the watermark as the newest notice shown — and nothing else', async () => {
    await markAnnouncementsSeen('2026-09-24T03:00:00.000Z');
    expect(mocked).toHaveBeenCalledWith('/me/announcements/seen', {
      method: 'POST',
      body: JSON.stringify({ upTo: '2026-09-24T03:00:00.000Z' }),
    });
  });

  /** A deep-linked notice from beyond the loaded pages is older than every
   *  page, so it is never new. */
  it('fetches one notice by id and marks it not new', async () => {
    mocked.mockResolvedValue({ id: 'x', createdAt: '2026-01-01T00:00:00.000Z' });
    const notice = await fetchAnnouncement('3f2b8c1e-9a4d-4c6b-8e21-5d7f0a9b1c23');
    expect(mocked).toHaveBeenCalledWith('/announcements/3f2b8c1e-9a4d-4c6b-8e21-5d7f0a9b1c23');
    expect(notice.isNew).toBe(false);
  });

  it('never calls the admin-ordered list or /me', async () => {
    await fetchMemberFeed(1);
    await markAnnouncementsSeen('2026-09-24T03:00:00.000Z');
    const paths = mocked.mock.calls.map((call) => call[0]);
    expect(paths.some((path) => path.startsWith('/announcements?'))).toBe(false);
    expect(paths).not.toContain('/me');
  });
});
