import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** A signed-in visitor on /register is routed on, not offered a second account (2026-10-23). */

const { getSession, apiFetch, replace, signUp, signOut } = vi.hoisted(() => ({
  getSession: vi.fn(),
  apiFetch: vi.fn(),
  replace: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession, signUp, signOut } } }));
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
  signOut.mockReset();
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
    expect(signOut).not.toHaveBeenCalled();
  });

  // Owner, 2026-10-30: the API refused this sign-up's account as under 12.
  it('a sign-up refused as under 12: signed out, the form, and the reason', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    apiFetch.mockRejectedValue(new ApiError('too young', 403, 'AGE_REQUIREMENT_NOT_MET'));
    await render();
    expect(signOut).toHaveBeenCalled();
    expect(form()).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'You need to be at least 12 years old to create an account.',
    );
    expect(replace).not.toHaveBeenCalled();
  });
});

function field(label: string): HTMLInputElement {
  const el = Array.from(container.querySelectorAll('label')).find(
    (node) => node.textContent === label,
  );
  return container.querySelector(`[id="${el?.getAttribute('for') ?? ''}"]`) as HTMLInputElement;
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function fillAndSubmit(password: string, dateOfBirth = '1995-05-05'): Promise<void> {
  type(field('Full name'), 'Juan Dela Cruz');
  type(field('Email'), 'juan@example.com');
  type(field('Date of birth'), dateOfBirth);
  type(field('Password'), password);
  type(field('Confirm password'), password);
  await act(async () => {
    form()?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** Sign-up follows the same five password rules as every screen that sets one (2026-10-26). */
describe('RegisterPage password', () => {
  beforeEach(() => {
    signUp.mockReset();
    getSession.mockResolvedValue({ data: { session: null } });
  });

  it('shows the rules checklist and an eye on both fields', async () => {
    await render();
    expect(container.querySelector('.pw-rules')).not.toBeNull();
    expect(container.querySelectorAll('button[aria-label="Show password"]')).toHaveLength(2);
  });

  it('refuses a password that misses a rule, before Supabase is asked', async () => {
    await render();
    await fillAndSubmit('longenough');
    expect(signUp).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Your password still needs an uppercase letter, a number and a special character.',
    );
  });

  it("signs up with a password that meets every rule, and puts Supabase's weak_password in plain words", async () => {
    signUp.mockResolvedValue({
      error: {
        code: 'weak_password',
        message: 'Password should contain at least one character of each: abc',
      },
    });
    await render();
    await fillAndSubmit('Thr0nes!Gym');
    expect(signUp).toHaveBeenCalledWith(expect.objectContaining({ password: 'Thr0nes!Gym' }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Choose a stronger password: at least 8 characters, with a lowercase and an uppercase letter, a number and a special character.',
    );
  });

  it('signs up with the password sign-in will compare against, without a pasted invisible character', async () => {
    signUp.mockResolvedValue({ error: { message: 'stop here' } });
    await render();
    await fillAndSubmit(`Thr0nes!Gym${String.fromCharCode(0x200b)}`);
    expect(signUp).toHaveBeenCalledWith(expect.objectContaining({ password: 'Thr0nes!Gym' }));
  });
});

/** Owner, 2026-10-30: nobody under 12 has an account. Refused before Supabase is asked. */
describe('RegisterPage date of birth', () => {
  beforeEach(() => {
    signUp.mockReset();
    getSession.mockResolvedValue({ data: { session: null } });
  });

  it('refuses under 12 with the shared message, and never signs up', async () => {
    await render();
    await fillAndSubmit('Thr0nes!Gym', '2020-06-01');
    expect(signUp).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'You need to be at least 12 years old to create an account.',
    );
  });

  it('offers no date in the picker after the latest 12th birthday', async () => {
    await render();
    const input = field('Date of birth');
    expect(input.type).toBe('date');
    const max = input.getAttribute('max') ?? '';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    expect(max).toBe(`${Number(today.slice(0, 4)) - 12}${today.slice(4)}`);
  });
});
