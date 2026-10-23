import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Arriving at /login already signed in (owner bug, 2026-10-23): a verified
 * session is routed on without the form; one still owed its code goes to the
 * code step for THIS session; no session gets the form.
 */

const { getSession, apiFetch, replace, sendLoginCode, searchParams } = vi.hoisted(() => ({
  getSession: vi.fn(),
  apiFetch: vi.fn(),
  replace: vi.fn(),
  sendLoginCode: vi.fn(),
  searchParams: { value: new URLSearchParams() },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession, signOut: vi.fn(), signInWithPassword: vi.fn() } },
}));
vi.mock('@/lib/api', () => ({
  apiFetch,
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('@/lib/loginCode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/loginCode')>()),
  sendLoginCode,
  verifyLoginCode: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => searchParams.value,
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('./AuthBrandPanel', () => ({ default: () => null }));

import LoginPage from './LoginPage';
import { ApiError } from '@/lib/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  getSession.mockReset();
  apiFetch.mockReset();
  replace.mockReset();
  sendLoginCode.mockReset();
  searchParams.value = new URLSearchParams();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => root.render(<LoginPage />));
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const passwordField = (): Element | null => container.querySelector('#login-password');

describe('LoginPage with an existing session', () => {
  it('no session: shows the password form', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    await render();

    expect(passwordField()).not.toBeNull();
    expect(container.textContent).not.toContain('Checking your sign-in');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('a verified session: routes on by permissions and never shows the form', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    apiFetch.mockResolvedValue({ permissions: [{ key: 'member.read', scope: 'ALL' }] });
    await render();

    expect(replace).toHaveBeenCalledWith('/admin');
    expect(passwordField()).toBeNull();
    expect(container.textContent).toContain('Checking your sign-in');
  });

  it('honours a permitted ?next=', async () => {
    searchParams.value = new URLSearchParams('next=/portal/bookings');
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    apiFetch.mockResolvedValue({ permissions: [] });
    await render();

    expect(replace).toHaveBeenCalledWith('/portal/bookings');
  });

  it('a session still owed its code: straight to the code step for it', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    apiFetch.mockRejectedValue(new ApiError('code', 401, 'LOGIN_CODE_REQUIRED'));
    sendLoginCode.mockResolvedValue({
      verified: false,
      sentTo: 'ju***@gmail.com',
      resendAvailableAt: null,
    });
    await render();

    expect(sendLoginCode).toHaveBeenCalledWith('tok');
    expect(container.textContent).toContain('CHECK YOUR EMAIL');
    expect(passwordField()).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('any other /me failure: the normal form', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await render();

    expect(passwordField()).not.toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});
