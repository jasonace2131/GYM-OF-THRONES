import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Arriving at /login already signed in (owner bug, 2026-10-23): a verified
 * session is routed on without the form; one still owed its code goes to the
 * code step for THIS session; no session gets the form.
 */

const { getSession, signOut, signInWithPassword, apiFetch, replace, sendLoginCode, searchParams } =
  vi.hoisted(() => ({
    getSession: vi.fn(),
    signOut: vi.fn(),
    signInWithPassword: vi.fn(),
    apiFetch: vi.fn(),
    replace: vi.fn(),
    sendLoginCode: vi.fn(),
    searchParams: { value: new URLSearchParams() },
  }));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession, signOut, signInWithPassword } },
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
  signOut.mockReset();
  signInWithPassword.mockReset();
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

describe('LoginPage after another device signed in (one device at a time)', () => {
  const NOTICE = 'You were signed out because your account signed in on another device.';

  it('?reason=replaced: shows the password form with the reason', async () => {
    searchParams.value = new URLSearchParams('reason=replaced&next=%2Fadmin');
    getSession.mockResolvedValue({ data: { session: null } });
    await render();

    expect(passwordField()).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(NOTICE);
  });

  it('no notice without the reason', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    await render();

    expect(container.textContent).not.toContain(NOTICE);
  });

  it('a session /me answers SESSION_REPLACED: the form and the reason, and NO global sign-out', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    apiFetch.mockRejectedValue(new ApiError('replaced', 401, 'SESSION_REPLACED'));
    await render();

    expect(passwordField()).not.toBeNull();
    expect(container.textContent).toContain(NOTICE);
    // apiFetch signs this device out LOCALLY; a global sign-out from the page
    // would also end the newer device's sign-in.
    expect(signOut).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(sendLoginCode).not.toHaveBeenCalled();
  });
});

/**
 * Owner, 2026-10-30: nobody under 12 has an account. The API refuses such a
 * sign-up on first sight with 403 AGE_REQUIREMENT_NOT_MET; the page signs the
 * session out and says why, rather than retrying or asking for a code.
 */
describe('LoginPage and an under-12 sign-up', () => {
  const MESSAGE = 'You need to be at least 12 years old to create an account.';
  const tooYoung = (): Error => new ApiError(MESSAGE, 403, 'AGE_REQUIREMENT_NOT_MET');
  const alertText = (): string | null | undefined =>
    container.querySelector('[role="alert"]')?.textContent;

  it('arriving signed in: signed out, the message over the form, no code sent', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    apiFetch.mockRejectedValue(tooYoung());
    await render();

    expect(signOut).toHaveBeenCalled();
    expect(passwordField()).not.toBeNull();
    expect(alertText()).toBe(MESSAGE);
    expect(sendLoginCode).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('signing in: signed out with the message, not retried', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    signInWithPassword.mockResolvedValue({
      data: { session: { access_token: 'tok' } },
      error: null,
    });
    apiFetch.mockRejectedValue(tooYoung());
    await render();

    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalled();
    expect(alertText()).toBe(MESSAGE);
    expect(sendLoginCode).not.toHaveBeenCalled();
  });
});
