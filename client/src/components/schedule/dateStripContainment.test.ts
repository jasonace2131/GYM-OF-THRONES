import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the fix for the Class Schedule's sideways scroll on phones.
 *
 * The bug: the date strip's 14-21 fixed-width chips sat in a CSS grid with no
 * explicit column track. An implicit `auto` track has a `min-content` minimum,
 * so the strip's full width (~830px, ~1250px on a priority plan) became the
 * width of the track — and of every card in it — and the page scrolled
 * sideways. The fix is `grid-cols-[minmax(0,1fr)]` on those grids and `min-w-0`
 * on the strip's ScrollArea, so the strip scrolls inside its own box.
 *
 * This is a SOURCE assertion on purpose: jsdom does no layout, so a rendered
 * test would report every width as 0 and pass whether or not the bug is back.
 */
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const PAGES = {
  schedule: read('../../app/portal/schedule/page.tsx'),
  book: read('../../app/portal/book/page.tsx'),
};

/** Every static className whose class list includes the `grid` utility. */
function gridClassNames(source: string): string[] {
  return [...source.matchAll(/className="([^"]*)"/g)]
    .map((match) => match[1] as string)
    .filter((classes) => classes.split(/\s+/).includes('grid'));
}

describe('date strip containment (no sideways page scroll on phones)', () => {
  it('the strip scrolls inside its own box: min-w-0 on its ScrollArea', () => {
    const strip = read('./DateStrip.tsx');
    expect(strip).toMatch(/<ScrollArea className="[^"]*\bmin-w-0\b[^"]*"/);
  });

  it('the strip never scrolls its ancestors (no scrollIntoView)', () => {
    // scrollIntoView scrolls every scrollable ancestor — on a phone it dragged
    // the whole page sideways to centre the selected day.
    expect(read('./DateStrip.tsx')).not.toMatch(/\.scrollIntoView\(/);
  });

  for (const [name, source] of Object.entries(PAGES)) {
    it(`every layout grid on the ${name} page has an explicit base column track`, () => {
      const grids = gridClassNames(source);
      expect(grids.length).toBeGreaterThan(0);
      for (const classes of grids) {
        // An unprefixed track: a breakpoint-only one leaves phones on `auto`.
        const tokens = classes.split(/\s+/);
        expect(
          tokens.some((token) => token === 'grid-cols-[minmax(0,1fr)]' || token === 'grid-cols-1'),
          `grid without a phone column track: "${classes}"`,
        ).toBe(true);
      }
    });
  }

  it('the grid that directly wraps <DateStrip> is minmax(0,1fr) and min-w-0', () => {
    const at = PAGES.schedule.indexOf('<DateStrip');
    expect(at).toBeGreaterThan(-1);
    const before = PAGES.schedule.slice(0, at);
    const wrapper = [...before.matchAll(/className="([^"]*)"/g)].at(-1)?.[1] ?? '';
    expect(wrapper.split(/\s+/)).toEqual(
      expect.arrayContaining(['grid', 'min-w-0', 'grid-cols-[minmax(0,1fr)]']),
    );
  });
});
