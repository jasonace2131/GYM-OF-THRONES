// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every Admin CRM table becomes one card per row on a phone (owner,
 * 2026-10-26). The cards are pure CSS (admin.css, "Tables become one card per
 * row") and OPT-IN: a table stacks only with `data-stack`, and a stacked cell
 * reads as "Label ……… value" only if it carries `data-label`. A cell with
 * neither a label nor a `data-card` role renders as a bare value nobody can
 * place — so this test reads the source and fails on either omission rather
 * than waiting for somebody to notice on a phone.
 */

const SRC = fileURLToPath(new URL('../..', import.meta.url));
const ROOTS = [join(SRC, 'app', 'admin'), join(SRC, 'components', 'admin')];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') && !name.includes('.test.') ? [path] : [];
  });
}

/** The opening tag starting at `start`, `>` found outside `{…}` and quotes. */
function openingTag(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

function tags(source: string, name: 'table' | 'td'): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}[\\s>]`, 'g');
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    out.push(openingTag(source, m.index));
  }
  return out;
}

const files = ROOTS.flatMap(tsxFiles).filter((path) =>
  readFileSync(path, 'utf8').includes('<table'),
);

describe('openingTag', () => {
  it('skips a > inside an arrow function in braces', () => {
    const src = '<td onClick={(e) => e.stop()} data-card="actions">x</td>';
    expect(openingTag(src, 0)).toBe('<td onClick={(e) => e.stop()} data-card="actions">');
  });
});

describe('admin tables stack into cards on a phone', () => {
  it('finds the admin tables', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((path) => [relative(SRC, path), path]))(
    '%s: every table opts in with data-stack',
    (_name, path) => {
      const source = readFileSync(path, 'utf8');
      for (const tag of tags(source, 'table')) {
        expect(tag).toMatch(/\bdata-stack\b/);
      }
    },
  );

  it.each(files.map((path) => [relative(SRC, path), path]))(
    '%s: every cell carries data-label, data-card or colSpan',
    (_name, path) => {
      const source = readFileSync(path, 'utf8');
      const bare = tags(source, 'td').filter(
        (tag) => !/\b(data-label|data-card|colSpan)\b/.test(tag),
      );
      expect(bare).toEqual([]);
    },
  );
});

/**
 * Below 900px a stacked table's <thead> is off-screen, so the roster's
 * header "select all" checkbox goes with it. A second control above the
 * cards carries the same state and handler, and shows only at that width.
 */
describe('roster select-all on cards', () => {
  const roster = readFileSync(join(SRC, 'app', 'admin', 'members', 'MembersRoster.tsx'), 'utf8');
  const css = readFileSync(join(SRC, 'app', 'admin.css'), 'utf8');

  it('renders a select-all above the cards wired like the header checkbox', () => {
    const start = roster.indexOf('<label className="a-select-all">');
    expect(start).toBeGreaterThan(-1);
    const control = openingTag(roster, roster.indexOf('<input', start));
    expect(control).toMatch(/ref=\{cardsCheckboxRef\}/);
    expect(control).toMatch(/checked=\{allPageSelected\}/);
    expect(control).toMatch(/onChange=\{toggleAllOnPage\}/);
    // Indeterminate is set on both boxes from the same effect.
    expect(roster).toMatch(/\[headerCheckboxRef\.current, cardsCheckboxRef\.current\]/);
  });

  it('is hidden on a desktop and a 44px row at 900px and below', () => {
    expect(css).toMatch(/\.a-select-all \{\s*display: none;/);
    expect(css).toMatch(
      /@media \(max-width: 900px\) \{\s*\.admin-root \.a-select-all \{\s*display: flex;[^}]*min-height: 44px;/,
    );
  });
});
