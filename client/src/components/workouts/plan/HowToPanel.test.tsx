import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HowToPanel, type GuideState } from './HowToPanel';

/** Every How-to panel leads with "Watch a demo", above the written steps. */

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

const READY: GuideState = {
  kind: 'ready',
  guide: {
    steps: ['Hold the bell at your chest.', 'Sit back.', 'Stand up.'],
    mistake: 'Knees caving in.',
    easier: 'Box squat.',
    harder: 'Pause at the bottom.',
  } as never,
};

function render(state: GuideState): void {
  act(() => {
    root.render(<HowToPanel state={state} exerciseName="Goblet squat" onRetry={() => {}} />);
  });
}

const demoLink = (): HTMLAnchorElement | null =>
  [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('Watch a demo')) ??
  null;

describe('HowToPanel', () => {
  it('opens a YouTube search for the exercise in a new tab, above the steps', () => {
    render(READY);
    const link = demoLink();
    expect(link?.href).toBe(
      'https://www.youtube.com/results?search_query=Goblet%20squat%20proper%20form',
    );
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
    const steps = container.querySelector('ol');
    expect(
      link!.compareDocumentPosition(steps!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('still offers the demo while the guide loads and when it fails', () => {
    render({ kind: 'loading' });
    expect(demoLink()).not.toBeNull();
    render({ kind: 'error', message: 'No guide right now.' });
    expect(demoLink()).not.toBeNull();
  });
});
