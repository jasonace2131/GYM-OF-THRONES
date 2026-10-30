import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DateStrip } from './DateStrip';

/**
 * The strip marks the days that have classes, not only the days the member
 * booked (gym report, 2026-10-30), and says so in each chip's spoken name.
 */

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

const DAYS = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'];

/** The 5px mark under a chip's date. */
const markOf = (chip: HTMLElement): string =>
  chip.querySelector('span[aria-hidden]')?.className ?? '';

async function draw(selected: string): Promise<HTMLElement[]> {
  await act(async () => {
    root.render(
      <DateStrip
        days={DAYS}
        today="2026-09-14"
        selected={selected}
        markedDays={new Set(['2026-09-16'])}
        classCounts={
          new Map([
            ['2026-09-15', 1],
            ['2026-09-16', 2],
            ['2026-09-17', 3],
          ])
        }
        onSelect={() => {}}
      />,
    );
  });
  return [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
}

describe('DateStrip', () => {
  it('says how many classes each day has, and which day is booked', async () => {
    const chips = await draw('2026-09-14');
    expect(chips.map((chip) => chip.getAttribute('aria-label'))).toEqual([
      'Monday 14 September, no classes',
      'Tuesday 15 September, 1 class',
      'Wednesday 16 September, 2 classes, you have a booking',
      'Thursday 17 September, 3 classes',
    ]);
  });

  it('rings a day with classes, fills a booked day, and leaves an empty day blank', async () => {
    const [empty, withClass, booked] = await draw('2026-09-14');
    expect(markOf(empty!)).toContain('bg-transparent');
    expect(markOf(withClass!)).toContain('ring-ink-3');
    expect(markOf(withClass!)).not.toContain('bg-gold');
    expect(markOf(booked!)).toContain('bg-gold');
    expect(markOf(booked!)).not.toContain('ring-1');
  });

  it('keeps the ring readable on the selected gold chip', async () => {
    const chips = await draw('2026-09-17');
    expect(markOf(chips[3]!)).toContain('ring-night/60');
  });
});
