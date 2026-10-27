import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** Reset password follows the same five rules as every screen that sets one (2026-10-26). */

const { updateUser, push } = vi.hoisted(() => ({ updateUser: vi.fn(), push: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: { access_token: 'recovery' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      updateUser,
    },
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock('./AuthBrandPanel', () => ({ default: () => null }));

import ResetPasswordPage from './ResetPasswordPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  updateUser.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
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
  await act(async () => root.render(<ResetPasswordPage />));
  await settle();
}

describe('ResetPasswordPage', () => {
  it('shows the rules checklist under the new password', async () => {
    await render();
    expect(container.querySelector('.pw-rules')).not.toBeNull();
    expect(container.querySelectorAll('button[aria-label="Show password"]')).toHaveLength(2);
  });

  it('refuses a password that misses a rule, and says which', async () => {
    await render();
    type(field('New password'), 'longenough');
    type(field('Confirm new password'), 'longenough');
    await submit();
    expect(updateUser).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Your password still needs an uppercase letter, a number and a special character.',
    );
    expect(container.querySelectorAll('.pw-rules li[data-state="missing"]')).toHaveLength(3);
  });

  it('clears the refusal once the member types again, like every other password screen', async () => {
    await render();
    type(field('New password'), 'longenough');
    await submit();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    type(field('New password'), 'longenough!');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(field('New password').getAttribute('aria-invalid')).toBeNull();
  });

  it('saves a password that meets every rule', async () => {
    updateUser.mockResolvedValue({ error: null });
    await render();
    type(field('New password'), 'Thr0nes!Gym');
    type(field('Confirm new password'), 'Thr0nes!Gym');
    await submit();
    expect(updateUser).toHaveBeenCalledWith({ password: 'Thr0nes!Gym' });
  });

  it("puts Supabase's weak_password in plain words", async () => {
    updateUser.mockResolvedValue({
      error: {
        code: 'weak_password',
        message: 'Password should contain at least one character of each: abc',
      },
    });
    await render();
    type(field('New password'), 'Thr0nes!Gym');
    type(field('Confirm new password'), 'Thr0nes!Gym');
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Choose a stronger password: at least 8 characters, with a lowercase and an uppercase letter, a number and a special character.',
    );
  });
});
