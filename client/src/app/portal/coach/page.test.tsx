import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** My Coach's single-column states sit centred, not pinned to the left. */

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/lib/api', () => ({ apiFetch }));
vi.mock('@/components/rbac/guards', () => ({
  RequirePermission: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/rbac/MeProvider', () => ({ usePermission: () => false }));
vi.mock('@/components/chat/RealtimeProvider', () => ({ useChat: () => null }));
vi.mock('@/components/chat/ChatPanel', () => ({ ChatHeader: () => null, ChatPanel: () => null }));

import CoachPage from './page';

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
  apiFetch.mockReset();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<CoachPage />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('My Coach page', () => {
  it('centres the "No coach assigned yet" column', async () => {
    apiFetch.mockResolvedValueOnce({ coach: null, upcomingSessions: [] });
    await render();

    expect(container.textContent).toContain('No coach assigned yet');
    const column = container.firstElementChild as HTMLElement;
    expect(column.getAttribute('style')).toContain('max-width: 760px');
    expect(column.getAttribute('style')).toContain('margin-inline: auto');
  });

  it('centres the load-failure state too', async () => {
    apiFetch.mockRejectedValueOnce(new Error('offline'));
    await render();

    expect(container.textContent).toContain('We could not load your coach');
    const column = container.firstElementChild as HTMLElement;
    expect(column.getAttribute('style')).toContain('margin-inline: auto');
  });
});
