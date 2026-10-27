import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NewPasswordFields } from './NewPasswordFields';

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

function Harness({
  initial = '',
  initialConfirm = '',
  showMissing = false,
}: {
  initial?: string;
  initialConfirm?: string;
  showMissing?: boolean;
}) {
  const [password, setPassword] = useState(initial);
  const [confirm, setConfirm] = useState(initialConfirm);
  return (
    <NewPasswordFields
      password={password}
      confirm={confirm}
      onPasswordChange={setPassword}
      onConfirmChange={setConfirm}
      labels={{ password: 'New password', confirm: 'Confirm new password' }}
      showMissing={showMissing}
    />
  );
}

function render(node: React.ReactNode): void {
  act(() => root.render(node));
}

/** React tracks the value it last set, so a plain `.value =` would not fire onChange. */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const input = (label: string): HTMLInputElement => {
  const labelEl = Array.from(container.querySelectorAll('label')).find(
    (el) => el.textContent === label,
  );
  const id = labelEl?.getAttribute('for') ?? '';
  return container.querySelector(`[id="${id}"]`) as HTMLInputElement;
};

const rules = (): { text: string; state: string | null }[] =>
  Array.from(container.querySelectorAll('.pw-rules li')).map((li) => ({
    text: li.querySelector('.pw-rule-text')?.textContent ?? '',
    state: li.getAttribute('data-state'),
  }));

describe('NewPasswordFields', () => {
  it('labels both fields and gives each its own reveal toggle', () => {
    render(<Harness />);
    expect(input('New password').type).toBe('password');
    expect(input('Confirm new password').type).toBe('password');
    expect(input('New password').getAttribute('autocomplete')).toBe('new-password');
    expect(container.querySelectorAll('button[aria-label="Show password"]')).toHaveLength(2);
  });

  it('reveals only the field whose eye was pressed', () => {
    render(<Harness />);
    const eyes = container.querySelectorAll('button[aria-label="Show password"]');
    act(() => (eyes[0] as HTMLButtonElement).click());
    expect(input('New password').type).toBe('text');
    expect(input('Confirm new password').type).toBe('password');
  });

  it('lists the five rules, all to do, before anything is typed', () => {
    render(<Harness />);
    expect(rules()).toEqual([
      { text: 'At least 8 characters', state: 'todo' },
      { text: 'A lowercase letter (a–z)', state: 'todo' },
      { text: 'An uppercase letter (A–Z)', state: 'todo' },
      { text: 'A number (0–9)', state: 'todo' },
      { text: 'A special character, like ! @ # $ %', state: 'todo' },
    ]);
  });

  it('ticks each rule off as it is met', () => {
    render(<Harness />);
    type(input('New password'), 'Gym2026');
    expect(rules().map((rule) => rule.state)).toEqual(['todo', 'met', 'met', 'met', 'todo']);
  });

  it('marks what is still missing after a failed save', () => {
    render(<Harness initial="Gym2026" showMissing />);
    expect(rules().map((rule) => rule.state)).toEqual(['missing', 'met', 'met', 'met', 'missing']);
  });

  it('points the new-password field at the checklist', () => {
    render(<Harness />);
    const listId = container.querySelector('.pw-rules')?.id ?? '';
    expect(listId).not.toBe('');
    expect(input('New password').getAttribute('aria-describedby')).toContain(listId);
  });

  it('shows the strength as a word, not only as a coloured bar', () => {
    render(<Harness />);
    type(input('New password'), 'Gym2026');
    expect(container.querySelector('.pw-strength-label')?.textContent).toBe('Fair');
    type(input('New password'), 'Thr0nes!Gym2');
    expect(container.querySelector('.pw-strength-label')?.textContent).toBe('Strong');
  });

  it('says nothing about matching until the confirmation is typed', () => {
    render(<Harness initial="Thr0nes!" />);
    expect(container.querySelector('.pw-match')).toBeNull();
  });

  it('says when the confirmation matches, and when it does not yet', () => {
    render(<Harness initial="Thr0nes!" />);
    type(input('Confirm new password'), 'Thr0n');
    expect(container.querySelector('.pw-match')?.textContent).toBe(
      'Doesn’t match the new password yet',
    );
    type(input('Confirm new password'), 'Thr0nes!');
    expect(container.querySelector('.pw-match')?.textContent).toBe('Passwords match');
  });

  it('matches the way a save compares, ignoring a pasted invisible character', () => {
    render(<Harness initial="Thr0nes!" />);
    type(input('Confirm new password'), `Thr0nes!${String.fromCharCode(0x200b)}`);
    expect(container.querySelector('.pw-match')?.textContent).toBe('Passwords match');
  });
});
