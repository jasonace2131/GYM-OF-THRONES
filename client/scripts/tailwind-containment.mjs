#!/usr/bin/env node
/**
 * Fails when legacy markup uses a class name Tailwind generated a utility for.
 *
 * Tailwind here scans only the folders named by @source in src/app/tailwind.css.
 * The generated utilities still apply to ANY element with a matching class —
 * so a legacy `className="grid"` would suddenly pick up `display:grid` once a
 * new component also used `grid`. This script reads the built CSS, collects
 * every utility selector, and searches the files Tailwind does NOT scan.
 *
 * Run after `next build`:  node scripts/tailwind-containment.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: the repo lives under "ALL PROJECTS", and
// pathname would keep the space as %20 and find no files at all.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NEXT_DIR = join(ROOT, '.next');
const SRC = join(ROOT, 'src');

// Folders Tailwind scans — must mirror the @source lines in tailwind.css.
const SCANNED = [
  'components/ui',
  'components/schedule',
  'components/admin/range',
  'components/announcements',
  'app/portal/dashboard',
  'app/portal/schedule',
  'app/portal/book',
  'app/portal/coaching',
  'app/portal/workouts',
  'components/workouts',
].map((p) => join(SRC, ...p.split('/')));

// Identical in both systems; a legacy use is harmless.
const ALLOWED = new Set(['sr-only']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function utilitiesBlocks(css) {
  const blocks = [];
  let at = css.indexOf('@layer utilities');
  while (at !== -1) {
    const open = css.indexOf('{', at);
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push(css.slice(open + 1, i - 1));
    at = css.indexOf('@layer utilities', i);
  }
  return blocks;
}

// Next 16 builds with Turbopack, which does not guarantee the Webpack-era
// .next/static/css layout. Walk .next and take every .css it emitted except
// the build cache, so a layout change cannot silently turn this gate off.
const cssFiles = walk(NEXT_DIR).filter(
  (f) => f.endsWith('.css') && !f.includes(`${sep}cache${sep}`),
);

const utilities = new Set();
for (const file of cssFiles) {
  for (const block of utilitiesBlocks(readFileSync(file, 'utf8'))) {
    for (const match of block.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)) {
      utilities.add(match[1].replace(/\\(.)/g, '$1'));
    }
  }
}

if (utilities.size === 0) {
  console.error(
    `No Tailwind utilities found in ${relative(ROOT, NEXT_DIR)} ` +
      `(${cssFiles.length} css files scanned) — run \`next build\` first.`,
  );
  process.exit(2);
}

const legacy = walk(SRC).filter(
  (f) => /\.(tsx|ts)$/.test(f) && !SCANNED.some((dir) => f.startsWith(dir + sep)),
);

const hits = [];
for (const file of legacy) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)) {
    const classes = (match[1] ?? match[2] ?? match[3] ?? '').split(/\s+/);
    for (const cls of classes) {
      if (cls !== '' && utilities.has(cls) && !ALLOWED.has(cls)) {
        hits.push(`${relative(ROOT, file)}: "${cls}"`);
      }
    }
  }
}

if (hits.length > 0) {
  console.error('Legacy markup matches generated Tailwind utilities:\n' + hits.join('\n'));
  process.exit(1);
}
console.log(`Tailwind contained: ${utilities.size} utilities, no legacy collisions.`);
