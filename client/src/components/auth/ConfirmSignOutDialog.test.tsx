import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SignOutButton } from './ConfirmSignOutDialog';

/** Every Sign out asks first (owner, 2026-10-23: "1 click for the signout is just not good"). */

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

const buttons = (label: string): HTMLButtonElement[] =>
  [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);

const dialog = (): HTMLElement | null => document.querySelector('[role="alertdialog"]');

async function renderButton(onConfirm: () => void | Promise<void>): Promise<HTMLButtonElement> {
  await act(async () => {
    root.render(
      <SignOutButton surface="member" className="p-link" onConfirm={onConfirm}>
        Sign out
      </SignOutButton>,
    );
  });
  const [trigger] = buttons('Sign out');
  return trigger!;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('SignOutButton + ConfirmSignOutDialog', () => {
  it('opens the confirmation on click instead of signing out', async () => {
    const onConfirm = vi.fn();
    const trigger = await renderButton(onConfirm);
    expect(dialog()).toBeNull();

    await act(async () => trigger.click());

    expect(onConfirm).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain('Sign out?');
    expect(dialog()?.textContent).toContain(
      "You'll need your password and an emailed code to sign back in.",
    );
  });

  it('starts on Cancel, so an accidental Enter does nothing', async () => {
    const trigger = await renderButton(vi.fn());
    await act(async () => trigger.click());
    await flush();
    expect(document.activeElement?.textContent).toBe('Cancel');
  });

  it('Cancel keeps the session', async () => {
    const onConfirm = vi.fn();
    const trigger = await renderButton(onConfirm);
    await act(async () => trigger.click());

    await act(async () => buttons('Cancel')[0]!.click());

    expect(onConfirm).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('Sign out signs out exactly once, even when tapped twice', async () => {
    let finish: () => void = () => undefined;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const trigger = await renderButton(onConfirm);
    await act(async () => trigger.click());

    const confirm = [...dialog()!.querySelectorAll('button')].find(
      (b) => b.textContent === 'Sign out',
    )!;
    await act(async () => confirm.click());
    await act(async () => confirm.click());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it('Escape cancels', async () => {
    const onConfirm = vi.fn();
    const trigger = await renderButton(onConfirm);
    await act(async () => trigger.click());
    await flush();

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });
});
