import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** A signed-in visitor on /register is routed on, not offered a second account (2026-10-23). */

const { getSession, apiFetch, replace } = vi.hoisted(() => ({
  getSession: vi.fn(),
  apiFetch: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession, signUp: vi.fn() } } }));
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
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('./AuthBrandPanel', () => ({ default: () => null }));

import RegisterPage from './RegisterPage';
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => root.render(<RegisterPage />));
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const form = (): Element | null => container.querySelector('form');

describe('RegisterPage with an existing session', () => {
  it('no session: the form', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    await render();
    expect(form()).not.toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('a verified member: routed to the portal, no form', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    apiFetch.mockResolvedValue({ permissions: [] });
    await render();
    expect(replace).toHaveBeenCalledWith('/portal/dashboard');
    expect(form()).toBeNull();
    expect(container.textContent).toContain('Checking your sign-in');
  });

  it('a sign-in still owed its code: to /login, which shows the code step', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    apiFetch.mockRejectedValue(new ApiError('code', 401, 'LOGIN_CODE_REQUIRED'));
    await render();
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('any other failure: the form', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await render();
    expect(form()).not.toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});
