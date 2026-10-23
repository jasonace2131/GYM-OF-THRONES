import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The dashboard noticeboard keeps a fixed height: the list scrolls inside the
 * card, while the heading and the "Showing N of M" footer stay outside it.
 */

const notices = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, isNew: false }));

vi.mock('./AnnouncementsProvider', () => ({
  useAnnouncements: () => ({
    state: {
      status: 'ready',
      pinned: [],
      items: notices,
      total: 12,
      page: 1,
      totalPages: 3,
      loadingMore: false,
    },
    loadMore: vi.fn(),
    retry: vi.fn(),
    injectNotice: vi.fn(),
  }),
}));
vi.mock('@/lib/announcements/api', () => ({ fetchAnnouncement: vi.fn() }));
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('./NoticeItem', () => ({
  NoticeItem: ({ notice }: { notice: { id: string } }) => <article data-id={notice.id} />,
}));

import { AnnouncementsSection } from './AnnouncementsSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AnnouncementsSection', () => {
  it('scrolls the list inside a fixed-height, keyboard-focusable region', async () => {
    await act(async () => {
      root.render(<AnnouncementsSection focus={null} onFocusHandled={() => {}} />);
    });

    const region = container.querySelector<HTMLElement>('[role="region"][aria-label="Announcements list"]');
    expect(region).not.toBeNull();
    expect(region?.tabIndex).toBe(0);
    expect(region?.className).toContain('overflow-y-auto');
    expect(region?.className).toContain('overscroll-contain');
    expect(region?.className).toMatch(/max-h-\[360px\]/);
    expect(region?.className).toMatch(/sm:max-h-\[420px\]/);
    expect(region?.querySelectorAll('article')).toHaveLength(5);

    // Heading and footer stay outside the scroll area.
    expect(region?.querySelector('h2')).toBeNull();
    expect(region?.textContent).not.toContain('Showing');
    expect(container.textContent).toContain('Showing 5 of 12 announcements');
  });
});
