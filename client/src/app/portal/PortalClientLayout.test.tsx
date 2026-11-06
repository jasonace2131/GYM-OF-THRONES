import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Staff stay out of the member portal (owner, 2026-11-07): a front-desk,
 * admin or dev account that opens a /portal address is sent to the console
 * and never sees the portal shell. Members and coaches are untouched.
 */

const { replace, me } = vi.hoisted(() => ({
  replace: vi.fn(),
  me: { value: null as null | { permissions: { key: string; scope: string }[] } },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/portal/dashboard',
  useRouter: () => ({ replace, push: vi.fn() }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { user: { email: 'a@b.co', user_metadata: { firstName: 'Ana' } } } },
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  },
}));
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(async () => ({ outstanding: [] })) }));
vi.mock('@/components/rbac/MeProvider', () => ({
  MeProvider: ({ children }: { children: React.ReactNode }) => children,
  useMe: () => ({
    me:
      me.value === null
        ? null
        : { firstName: 'Ana', lastName: 'Reyes', role: 'X', permissions: me.value.permissions },
  }),
}));
vi.mock('@/components/chat/RealtimeProvider', () => ({
  RealtimeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/announcements/AnnouncementsProvider', () => ({
  AnnouncementsProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/announcements/MemberNoticesProvider', () => ({
  MemberNoticesProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/announcements/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/portal/Sidebar', () => ({ Sidebar: () => null, MobileTabBar: () => null }));
vi.mock('@/components/portal/MoreSheet', () => ({ MoreSheet: () => null }));
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));

import PortalClientLayout from './PortalClientLayout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const render = async (): Promise<void> => {
  await act(async () => root.render(<PortalClientLayout>member page</PortalClientLayout>));
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  replace.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('PortalClientLayout and staff accounts', () => {
  it('sends a staff account to the console, without ever showing the portal', async () => {
    me.value = { permissions: [{ key: 'member.read', scope: 'ALL' }] };
    await render();

    expect(replace).toHaveBeenCalledWith('/admin');
    expect(container.querySelector('.p-shell')).toBeNull();
    expect(container.textContent).not.toContain('member page');
    expect(container.textContent).toContain('Redirecting…');
  });

  it('shows a member their portal', async () => {
    me.value = { permissions: [{ key: 'membership.self', scope: 'OWN' }] };
    await render();

    expect(replace).not.toHaveBeenCalledWith('/admin');
    expect(container.querySelector('.p-shell')).not.toBeNull();
    expect(container.textContent).toContain('member page');
  });

  it('leaves a coach in the portal, where their coach dashboard lives', async () => {
    me.value = { permissions: [{ key: 'coach.read', scope: 'OWN' }] };
    await render();

    expect(replace).not.toHaveBeenCalledWith('/admin');
    expect(container.querySelector('.p-shell')).not.toBeNull();
  });

  it('does not wait on /me to show the portal (the offline check-in screen relies on it)', async () => {
    me.value = null;
    await render();

    expect(replace).not.toHaveBeenCalled();
    expect(container.querySelector('.p-shell')).not.toBeNull();
  });
});
