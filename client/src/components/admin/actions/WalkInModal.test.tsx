import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@/lib/adminApi', () => ({ adminApi: { sellWalkIn: vi.fn() } }));
vi.mock('@/lib/api', () => ({ ApiError: class ApiError extends Error {} }));

import { WalkInModal } from './WalkInModal';
import { walkInSaleProblem } from '@/lib/walkInGuest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // jsdom has no <dialog> methods.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function type(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('WalkInModal — Take payment explains itself', () => {
  it('stays enabled and shows the problem on click instead of silently refusing', async () => {
    await act(async () => root.render(<WalkInModal open onClose={vi.fn()} onSold={vi.fn()} />));
    const name = document.getElementById('walkin-name') as HTMLInputElement;
    await type(name, 'A');
    const take = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Take payment',
    )!;
    expect(take.disabled).toBe(false);
    await act(async () => take.click());
    expect(document.body.textContent).toContain("Enter the guest's name");
  });
});

describe('walkInSaleProblem', () => {
  const ok = {
    guest: true,
    name: 'Ana Cruz',
    email: 'ana@x.com',
    phone: '',
    emergencyContact: '',
    waiverAccepted: true,
    method: 'CASH',
    reference: '',
  };

  it('is null for a complete cash sale, even with a leftover reference', () => {
    expect(walkInSaleProblem({ ...ok, reference: '12' })).toBeNull();
  });

  it.each<[Partial<typeof ok>, RegExp]>([
    [{ name: 'A' }, /guest's name/],
    [{ phone: 'call me' }, /PH mobile/],
    [{ email: 'nope' }, /email/],
    [{ waiverAccepted: false }, /waiver/],
    [{ method: 'GCASH', reference: '12' }, /4–64 characters/],
  ])('says why for %j', (patch, problem) => {
    expect(walkInSaleProblem({ ...ok, ...patch })).toMatch(problem);
  });

  it('skips the guest checks for a member resolved from a denial', () => {
    expect(walkInSaleProblem({ ...ok, guest: false, name: '', email: '' })).toBeNull();
  });
});
