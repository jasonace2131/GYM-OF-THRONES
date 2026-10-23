import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MemberAccess } from '@got/shared';

/**
 * A lapsed member (READ_ONLY) keeps their plans on screen but is offered no
 * write: no Start, no Regenerate, no Edit by hand. An active member sees them
 * all. The server refuses the writes either way (403 MEMBERSHIP_REQUIRED).
 */

const { useMe } = vi.hoisted(() => ({ useMe: vi.fn() }));
vi.mock('@/components/rbac/MeProvider', () => ({ useMe }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { MembershipGate } from '@/components/portal/MembershipGate';
import { StartDayButton } from './session/StartDayButton';
import { PlanHeader } from './plan/PlanHeader';
import type { SessionStarter } from './session/useSessionStarter';
import { FinishScreen } from './history/FinishScreen';
import { INTAKE, SUMMARY } from '@/lib/workouts/fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const starter = {
  state: { kind: 'idle' },
  start: vi.fn(),
} as unknown as SessionStarter;

async function renderAs(access: MemberAccess, node: React.ReactNode): Promise<void> {
  useMe.mockReturnValue({ me: { id: 'u1', permissions: [], memberAccess: access } });
  await act(async () => {
    root.render(<MembershipGate feature="workouts">{node}</MembershipGate>);
  });
}

const Screen = () => (
  <>
    <PlanHeader
      name="Push Pull Legs"
      intake={INTAKE}
      meta={null}
      isActive
      mode="saved"
      editing={false}
      busy={false}
      regenerateHref="/portal/workouts/new?from=p1"
      onEdit={vi.fn()}
    />
    <StartDayButton
      starter={starter}
      dayName="Full body A"
      body={{ source: 'MEMBER_PLAN', planId: 'p1', weekday: 1 }}
    />
  </>
);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const labels = () => [...container.querySelectorAll('a, button')].map((el) => el.textContent);

describe('a saved plan, read-only', () => {
  it('shows the plan but offers no Start, Regenerate or Edit by hand', async () => {
    await renderAs('READ_ONLY', <Screen />);

    expect(container.textContent).toContain('Push Pull Legs');
    expect(container.querySelector('[aria-label^="Start this day"]')).toBeNull();
    expect(labels().join('|')).not.toMatch(/Regenerate|Edit by hand/);
  });

  it('offers all three to an active member', async () => {
    await renderAs('FULL', <Screen />);

    expect(container.querySelector('[aria-label^="Start this day"]')).not.toBeNull();
    expect(labels().join('|')).toMatch(/Regenerate/);
    expect(labels().join('|')).toMatch(/Edit by hand/);
  });
});

describe('"How did it feel?" after a workout', () => {
  // PATCH sessions/:id is gated, so the picker is switched off — kept on
  // screen, disabled, so the layout does not jump.
  const feelings = () =>
    [...document.querySelectorAll('[aria-label="How did it feel"] button')] as HTMLButtonElement[];
  const finish = (
    <FinishScreen summary={SUMMARY} feelingBusy={false} feelingError={null} onFeeling={vi.fn()} />
  );

  it('is shown but disabled for a lapsed member', async () => {
    await renderAs('READ_ONLY', finish);
    expect(feelings().length).toBeGreaterThan(0);
    expect(feelings().every((button) => button.disabled)).toBe(true);
  });

  it('is live for an active member', async () => {
    await renderAs('FULL', finish);
    expect(feelings().length).toBeGreaterThan(0);
    expect(feelings().some((button) => button.disabled)).toBe(false);
  });
});
