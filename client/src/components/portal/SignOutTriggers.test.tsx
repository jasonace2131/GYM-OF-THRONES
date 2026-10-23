import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('next/navigation', () => ({ usePathname: () => '/portal/dashboard' }));
vi.mock('@/components/chat/NavItemBadge', () => ({ NavItemBadge: () => null }));

import { Sidebar } from './Sidebar';
import { MoreSheet } from './MoreSheet';

/** The portal shell's Sign out controls ask first (owner, 2026-10-23). */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const trigger = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no ${label}`);
  return found;
};

const dialog = (): HTMLElement | null => document.querySelector('[role="alertdialog"]');

async function confirmInDialog(): Promise<void> {
  const confirm = [...dialog()!.querySelectorAll('button')].find(
    (b) => b.textContent === 'Sign out',
  )!;
  await act(async () => confirm.click());
}

describe('portal Sidebar', () => {
  it('opens the confirmation; signs out only on confirm', async () => {
    const onSignOut = vi.fn();
    await act(async () => root.render(<Sidebar onSignOut={onSignOut} />));

    await act(async () => trigger('Sign Out').click());
    expect(onSignOut).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain('Sign out?');

    await confirmInDialog();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('More sheet', () => {
  it('opens the confirmation over the sheet; Escape cancels the dialog, not the sheet', async () => {
    const onSignOut = vi.fn();
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <MoreSheet open onClose={onClose} groups={[]} onSignOut={onSignOut} surface="admin" />,
      ),
    );

    await act(async () => trigger('Sign out').click());
    expect(onSignOut).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    // The console keeps its danger button.
    const confirm = [...dialog()!.querySelectorAll('button')].find(
      (b) => b.textContent === 'Sign out',
    )!;
    expect(confirm.className).toContain('p-btn-danger');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(dialog()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSignOut).not.toHaveBeenCalled();

    await act(async () => trigger('Sign out').click());
    await confirmInDialog();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
