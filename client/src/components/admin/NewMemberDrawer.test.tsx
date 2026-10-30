import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Owner, 2026-10-30: the desk's "New member" asks for the date of birth, and
 * no account is ever created for somebody under 12.
 */

const { createMember } = vi.hoisted(() => ({ createMember: vi.fn() }));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), ApiError: class ApiError extends Error {} }));
vi.mock('@/lib/adminApi', () => ({
  adminApi: { createMember, plans: vi.fn(), gymConfig: vi.fn(), resendInvite: vi.fn() },
  peso: (centavos: number) => `₱${centavos / 100}`,
}));
vi.mock('@/lib/useAdminQuery', () => ({
  useAdminQuery: () => ({ data: null, loading: false, error: null }),
}));
vi.mock('@/components/rbac/MeProvider', () => ({ usePermission: () => false }));
vi.mock('next/link', () => ({ default: () => null }));

import { NewMemberDrawer } from './NewMemberDrawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  createMember.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function type(selector: string, value: string): void {
  const input = container.querySelector(selector) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The drawer's own Create button (the confirm dialog's has the same words). */
function createButton(): HTMLButtonElement {
  return Array.from(container.querySelectorAll('.a-drawer-body button')).find(
    (button) => button.textContent === 'Create member',
  ) as HTMLButtonElement;
}

async function render(): Promise<void> {
  await act(async () =>
    root.render(<NewMemberDrawer onClose={vi.fn()} onCreated={vi.fn()} onOpenMember={vi.fn()} />),
  );
  type('#new-member-first', 'Juan');
  type('#new-member-last', 'Dela Cruz');
  type('#new-member-email', 'juan@example.com');
}

describe('NewMemberDrawer date of birth', () => {
  it('is required: Create stays off until it is given', async () => {
    await render();
    expect(container.querySelector('#new-member-dob')).not.toBeNull();
    expect(createButton().disabled).toBe(true);
  });

  it('refuses under 12 with the shared message, and Create stays off', async () => {
    await render();
    type('#new-member-dob', '2020-06-01');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'You need to be at least 12 years old to create an account.',
    );
    expect(createButton().disabled).toBe(true);
  });

  it('sends a date that is old enough with the new member', async () => {
    createMember.mockResolvedValue({
      member: { firstName: 'Juan', lastName: 'Dela Cruz', email: 'juan@example.com' },
      emailSent: true,
    });
    await render();
    type('#new-member-dob', '1995-05-05');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(createButton().disabled).toBe(false);

    await act(async () => createButton().click());
    const confirm = Array.from(container.querySelectorAll('.a-modal button')).find(
      (button) => button.textContent === 'Create member',
    ) as HTMLButtonElement;
    await act(async () => confirm.click());

    expect(createMember).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'juan@example.com', dateOfBirth: '1995-05-05' }),
    );
  });
});
