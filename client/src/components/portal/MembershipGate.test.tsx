import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MemberAccess } from '@got/shared';

/**
 * The member-only features' gate, rendered in jsdom with `/me` mocked: a
 * locked page for somebody who never had a membership, a read-only notice
 * (and writes switched off) for one whose membership is not active, and the
 * page itself for an active member or staff.
 */

const { useMe } = vi.hoisted(() => ({ useMe: vi.fn() }));
vi.mock('@/components/rbac/MeProvider', () => ({ useMe }));

import { MembershipGate, WritesOnly, useMemberCanWrite } from './MembershipGate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Probe() {
  const canWrite = useMemberCanWrite();
  return (
    <div data-testid="page">
      <button type="button" disabled={!canWrite}>
        Generate
      </button>
    </div>
  );
}

function meWith(access: MemberAccess | undefined | null) {
  useMe.mockReturnValue({
    me: access === null ? null : { id: 'u1', permissions: [], memberAccess: access },
  });
}

async function render(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(node);
  });
}

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

const page = () => container.querySelector('[data-testid="page"]');
const generate = () => container.querySelector('button') as HTMLButtonElement | null;

describe('MembershipGate', () => {
  it('shows the locked page, not the feature, to somebody who never had a membership', async () => {
    meWith('LOCKED');
    await render(
      <MembershipGate feature="workouts">
        <Probe />
      </MembershipGate>,
    );

    expect(page()).toBeNull();
    expect(container.querySelector('h1')?.textContent).toMatch(/Workouts/);
    const cta = container.querySelector('a');
    expect(cta?.getAttribute('href')).toBe('/portal/subscription');
    // Flat dark button, never the gold gradient (owner).
    expect(cta?.className).toContain('p-btn-dark');
    expect(cta?.className).not.toContain('p-btn-gold');
  });

  it('shows the page read-only under the notice when the membership is not active', async () => {
    meWith('READ_ONLY');
    await render(
      <MembershipGate feature="assistant">
        <Probe />
      </MembershipGate>,
    );

    expect(page()).not.toBeNull();
    expect(container.textContent).toContain(
      "Your membership isn't active. Renew to keep using this.",
    );
    expect(container.querySelector('a[href="/portal/subscription"]')).not.toBeNull();
    expect(generate()?.disabled).toBe(true);
  });

  it('shows the page untouched for an active member (or staff)', async () => {
    meWith('FULL');
    await render(
      <MembershipGate feature="progress">
        <Probe />
      </MembershipGate>,
    );

    expect(page()).not.toBeNull();
    expect(container.textContent).not.toContain("Your membership isn't active");
    expect(generate()?.disabled).toBe(false);
  });

  it('falls open against an API that predates memberAccess — the server still gates', async () => {
    meWith(undefined);
    await render(
      <MembershipGate feature="coach">
        <Probe />
      </MembershipGate>,
    );

    expect(page()).not.toBeNull();
    expect(generate()?.disabled).toBe(false);
  });

  it('renders nothing of the feature while /me is loading', async () => {
    meWith(null);
    await render(
      <MembershipGate feature="workouts">
        <Probe />
      </MembershipGate>,
    );

    expect(page()).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('useMemberCanWrite outside a gate', () => {
  it('is true: coaches and the console use the same components ungated', async () => {
    await render(<Probe />);
    expect(generate()?.disabled).toBe(false);
  });
});

describe('WritesOnly', () => {
  it('replaces a write-only screen (a new plan, a workout) for a read-only member', async () => {
    meWith('READ_ONLY');
    await render(
      <MembershipGate feature="workouts">
        <WritesOnly backHref="/portal/workouts" backLabel="Back to Workouts">
          <Probe />
        </WritesOnly>
      </MembershipGate>,
    );

    expect(page()).toBeNull();
    expect(container.querySelector('a[href="/portal/workouts"]')?.textContent).toMatch(
      /Back to Workouts/,
    );
  });

  it('passes through for an active member', async () => {
    meWith('FULL');
    await render(
      <MembershipGate feature="workouts">
        <WritesOnly backHref="/portal/workouts" backLabel="Back to Workouts">
          <Probe />
        </WritesOnly>
      </MembershipGate>,
    );

    expect(page()).not.toBeNull();
  });
});
