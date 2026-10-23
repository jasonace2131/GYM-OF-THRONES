import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** The console sidebar's Sign out asks first (owner, 2026-10-23). */

const { signOut, replace } = vi.hoisted(() => ({
  signOut: vi.fn(async () => ({ error: null })),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => ({ replace, push: vi.fn() }),
}));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { signOut } } }));
vi.mock('@/components/rbac/MeProvider', () => ({
  MeProvider: ({ children }: { children: React.ReactNode }) => children,
  useMe: () => ({
    status: 'ready',
    errorStatus: null,
    reload: vi.fn(),
    me: {
      firstName: 'Ana',
      lastName: 'Reyes',
      role: 'ADMIN',
      permissions: [{ key: 'member.read', scope: 'ALL' }],
    },
  }),
}));
vi.mock('@/components/admin/ShiftPill', () => ({ ShiftPill: () => null }));
vi.mock('@/components/announcements/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/announcements/AnnouncementsProvider', () => ({
  AnnouncementsProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/portal/SurfaceSwitch', () => ({ SurfaceSwitch: () => null }));
vi.mock('@/components/chat/NavItemBadge', () => ({ NavItemBadge: () => null }));
vi.mock('@/components/rbac/guards', () => ({
  RequirePermission: ({ children }: { children: React.ReactNode }) => children,
}));

import AdminLayout from './layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  signOut.mockClear();
  replace.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('admin sidebar Sign out', () => {
  it('opens the confirmation; signs out only on confirm', async () => {
    await act(async () => root.render(<AdminLayout>page</AdminLayout>));

    const trigger = [...container.querySelectorAll('.p-sidebar button')].find(
      (b) => b.textContent?.trim() === 'Sign out',
    ) as HTMLButtonElement;
    await act(async () => trigger.click());

    expect(signOut).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Sign out?');

    const confirm = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent === 'Sign out',
    )!;
    expect(confirm.className).toContain('p-btn-danger');
    await act(async () => confirm.click());

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/login');
  });
});
