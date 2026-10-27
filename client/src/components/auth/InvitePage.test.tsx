import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** A staff invite's new password follows the same five rules (2026-10-26). */

const { updateUser, lookup, match, accept } = vi.hoisted(() => ({
  updateUser: vi.fn(),
  lookup: vi.fn(),
  match: vi.fn(),
  accept: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: { user: { email: 'coach@example.com' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      updateUser,
      signOut: vi.fn(),
    },
  },
}));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({ permissions: [] }),
  ApiError: class ApiError extends Error {},
}));
vi.mock('@/lib/staffApi', () => ({ inviteApi: { lookup, match, accept, claimLink: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('./AuthBrandPanel', () => ({ default: () => null }));

import InvitePage from './InvitePage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  updateUser.mockReset();
  accept.mockReset();
  lookup.mockResolvedValue({ role: 'COACH', maskedEmail: 'c***h@example.com' });
  match.mockResolvedValue({ matches: true });
  // "Set up my account" was pressed: back from Supabase, a password is owed.
  window.sessionStorage.setItem('got:invite-claimed:tok', '1');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.sessionStorage.clear();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

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

async function submit(): Promise<void> {
  const form = container.querySelector('form') as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function render(): Promise<void> {
  await act(async () => root.render(<InvitePage token="tok" />));
  await settle();
}

describe('InvitePage password', () => {
  it('shows the rules checklist and an eye on both fields', async () => {
    await render();
    expect(container.querySelector('.pw-rules')).not.toBeNull();
    expect(container.querySelectorAll('button[aria-label="Show password"]')).toHaveLength(2);
  });

  it('refuses a password that misses a rule, before anything is saved', async () => {
    await render();
    type(field('Password'), 'longenough');
    type(field('Confirm password'), 'longenough');
    await submit();
    expect(updateUser).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Your password still needs an uppercase letter, a number and a special character.',
    );
  });

  it('saves a password that meets every rule', async () => {
    updateUser.mockResolvedValue({ error: null });
    accept.mockResolvedValue({});
    await render();
    type(field('Password'), 'Thr0nes!Gym');
    type(field('Confirm password'), 'Thr0nes!Gym');
    await submit();
    expect(updateUser).toHaveBeenCalledWith({ password: 'Thr0nes!Gym' });
  });
});
