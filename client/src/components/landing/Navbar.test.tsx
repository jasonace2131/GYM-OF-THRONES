import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A signed-in visitor on the public site is offered their way back in, not a
 * Log in that costs a password and a new emailed code (owner bug, 2026-10-23).
 */

const { getSession, apiFetch } = vi.hoisted(() => ({
  getSession: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession } } }));
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
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import Navbar from './Navbar';
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const withSession = (): void => {
  getSession.mockResolvedValue({ data: { session: { access_token: 't' } } });
};

async function render(): Promise<void> {
  await act(async () => root.render(<Navbar />));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Every link in the header, desktop and mobile menu, as [text, href]. */
const links = (): Array<[string, string]> =>
  [...container.querySelectorAll('a')].map((a) => [
    (a.textContent ?? '').trim().toLowerCase(),
    a.getAttribute('href') ?? '',
  ]);

const accountLinks = (): Array<[string, string]> =>
  links().filter(([text]) =>
    ['log in', 'login', 'my portal', 'staff console', 'continue'].includes(text),
  );

describe('Navbar account button', () => {
  it('without a session: Log in, and no /me call', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    await render();

    expect(accountLinks()).toEqual([
      ['login', '/login'],
      ['log in', '/login'],
    ]);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('a member with a session: My portal, to the member dashboard', async () => {
    withSession();
    apiFetch.mockResolvedValue({ permissions: [] });
    await render();

    expect(apiFetch).toHaveBeenCalledWith('/me');
    expect(accountLinks()).toEqual([
      ['my portal', '/portal/dashboard'],
      ['my portal', '/portal/dashboard'],
    ]);
  });

  it('staff with a session: Staff console, to /admin', async () => {
    withSession();
    apiFetch.mockResolvedValue({ permissions: [{ key: 'member.read', scope: 'ALL' }] });
    await render();

    expect(accountLinks()).toEqual([
      ['staff console', '/admin'],
      ['staff console', '/admin'],
    ]);
  });

  it('a sign-in still owed its code: Continue, to /login (which shows the code step)', async () => {
    withSession();
    apiFetch.mockRejectedValue(new ApiError('code', 401, 'LOGIN_CODE_REQUIRED'));
    await render();

    expect(accountLinks()).toEqual([
      ['continue', '/login'],
      ['continue', '/login'],
    ]);
  });

  it('while /me is unanswered: Continue, to /login', async () => {
    withSession();
    apiFetch.mockReturnValue(new Promise(() => undefined));
    await render();

    expect(accountLinks()).toEqual([
      ['continue', '/login'],
      ['continue', '/login'],
    ]);
  });
});
