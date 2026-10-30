import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** /join follows the same five password rules as every screen that sets one (2026-10-26). */

const { updateUser, lookup, accept } = vi.hoisted(() => ({
  updateUser: vi.fn(),
  lookup: vi.fn(),
  accept: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: { user: { email: 'juan@example.com' } } } }),
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
vi.mock('@/lib/memberJoin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/memberJoin')>()),
  memberJoinApi: { lookup, accept, claimLink: vi.fn() },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('./AuthBrandPanel', () => ({ default: () => null }));

import JoinPage from './JoinPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  updateUser.mockReset();
  accept.mockReset();
  lookup.mockReset();
  lookup.mockResolvedValue({ firstName: 'Juan', status: 'PENDING', email: 'juan@example.com' });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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
  await act(async () => root.render(<JoinPage token="tok" />));
  await settle();
}

describe('JoinPage password', () => {
  it('shows the rules checklist and an eye on both fields', async () => {
    await render();
    expect(container.querySelector('.pw-rules')).not.toBeNull();
    expect(container.querySelectorAll('button[aria-label="Show password"]')).toHaveLength(2);
  });

  it('refuses a password that misses a rule, before anything is saved', async () => {
    await render();
    type(field('Password'), 'longenough');
    type(field('Confirm password'), 'longenough');
    type(field('Date of birth'), '1995-05-05');
    await submit();
    expect(updateUser).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Your password still needs an uppercase letter, a number and a special character.',
    );
  });

  it('saves a password that meets every rule', async () => {
    updateUser.mockResolvedValue({ error: null });
    accept.mockResolvedValue({ dateOfBirthSaved: true });
    await render();
    type(field('Password'), 'Thr0nes!Gym');
    type(field('Confirm password'), 'Thr0nes!Gym');
    type(field('Date of birth'), '1995-05-05');
    await submit();
    expect(updateUser).toHaveBeenCalledWith({ password: 'Thr0nes!Gym' });
    expect(accept).toHaveBeenCalledWith('tok', '1995-05-05');
  });
});

/** Owner, 2026-10-30: nobody under 12 has an account. */
describe('JoinPage date of birth', () => {
  it('refuses under 12 before the password is saved or the link is used', async () => {
    await render();
    type(field('Password'), 'Thr0nes!Gym');
    type(field('Confirm password'), 'Thr0nes!Gym');
    type(field('Date of birth'), '2020-06-01');
    await submit();
    expect(updateUser).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'You need to be at least 12 years old to create an account.',
    );
  });

  it('does not ask when the desk already entered it, and sends none', async () => {
    lookup.mockResolvedValue({
      firstName: 'Juan',
      status: 'PENDING',
      email: 'juan@example.com',
      needsDateOfBirth: false,
    });
    updateUser.mockResolvedValue({ error: null });
    accept.mockResolvedValue({ dateOfBirthSaved: false });
    await render();
    expect(container.querySelector('#join-dob')).toBeNull();
    type(field('Password'), 'Thr0nes!Gym');
    type(field('Confirm password'), 'Thr0nes!Gym');
    await submit();
    expect(updateUser).toHaveBeenCalledWith({ password: 'Thr0nes!Gym' });
    expect(accept).toHaveBeenCalledWith('tok', undefined);
  });
});
