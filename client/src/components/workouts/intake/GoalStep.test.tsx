import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { initialIntake } from '@/lib/workouts/intake';
import { GoalStep } from './GoalStep';

/** Step 1 shows the account's numbers and hides Lose fat under BMI 18.5. */

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

function render(body: { heightCm: number | null; weightKg: number | null } | null): void {
  act(() => {
    root.render(
      <GoalStep state={initialIntake()} problem={null} dispatch={() => {}} body={body} />,
    );
  });
}

const goalTitles = (): string[] =>
  [...container.querySelectorAll('[role="radio"]')].map(
    (el) => el.querySelector('span')?.textContent ?? '',
  );

describe('GoalStep', () => {
  it('shows the account numbers with an edit link, and every goal', () => {
    render({ heightCm: 170, weightKg: 70 });
    expect(container.textContent).toContain('From your account: 170 cm · 70 kg · BMI 24.2');
    const link = container.querySelector<HTMLAnchorElement>('a[href="/portal/account"]');
    expect(link?.textContent).toBe('Edit in My Account');
    expect(goalTitles()).toContain('Lose fat');
    expect(container.textContent).not.toContain('is hidden');
  });

  it('hides Lose fat under BMI 18.5 and says why', () => {
    render({ heightCm: 180, weightKg: 55 });
    expect(goalTitles()).not.toContain('Lose fat');
    expect(goalTitles()).toHaveLength(5);
    expect(container.textContent).toContain('Lose fat is hidden because your BMI is under 18.5.');
  });

  it('asks for the numbers when they are missing, and shows every goal', () => {
    render({ heightCm: null, weightKg: null });
    expect(container.textContent).toContain(
      'Add your height and weight in My Account so the planner can fit the goals to you.',
    );
    expect(container.querySelector('a[href="/portal/account"]')).not.toBeNull();
    expect(goalTitles()).toHaveLength(6);
  });

  it('shows no line when the account could not be read', () => {
    render(null);
    expect(container.querySelector('a[href="/portal/account"]')).toBeNull();
    expect(goalTitles()).toHaveLength(6);
  });
});
