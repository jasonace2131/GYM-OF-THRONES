import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from '../api';
import { adminApi } from '../adminApi';

/**
 * The rich-announcement wrappers: path, method and body only (the same
 * contract as adminApi.test.ts, kept in its own file so parallel branches do
 * not collide in that one).
 */
describe('adminApi — rich announcements', () => {
  const doc = {
    type: 'doc' as const,
    content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'x' }] }],
  };

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
  });

  it('createAnnouncement() sends contentJson and the cover, and no plain content', async () => {
    await adminApi.createAnnouncement({
      title: 'Hours',
      contentJson: doc,
      coverImageUrl: 'https://x/c.webp',
      isPinned: true,
    });
    const [path, init] = vi.mocked(apiFetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/admin/announcements');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      title: 'Hours',
      contentJson: doc,
      coverImageUrl: 'https://x/c.webp',
      isPinned: true,
    });
  });

  it('updateAnnouncement() can remove a cover with an explicit null', async () => {
    await adminApi.updateAnnouncement('a1', { coverImageUrl: null });
    const [path, init] = vi.mocked(apiFetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/admin/announcements/a1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ coverImageUrl: null });
  });

  it('announcementUploadStatus() reads the upload status', async () => {
    await adminApi.announcementUploadStatus();
    expect(apiFetch).toHaveBeenCalledWith('/admin/announcements/uploads');
  });

  it('signAnnouncementUpload() declares only the type and size — never a path', async () => {
    await adminApi.signAnnouncementUpload({ contentType: 'image/webp', size: 1234 });
    const [path, init] = vi.mocked(apiFetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/admin/announcements/uploads');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ contentType: 'image/webp', size: 1234 });
  });
});
