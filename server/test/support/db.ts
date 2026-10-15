import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

const SERVER_ROOT = join(__dirname, '..', '..');

/**
 * Tables the seed owns. Everything else in `public` is truncated between
 * suites, so a new model needs no edit here — which is the point: a forgotten
 * entry in a hand-maintained list is a test that passes on stale rows.
 */
const PRESERVED_TABLES = ['Permission', 'RolePermission', '_prisma_migrations'];

let prepared = false;

/**
 * Points this process at the scratch database.
 *
 * Reads server/.env.test with a 10-line parser rather than taking a dotenv
 * dependency, and refuses to run at all without TEST_DATABASE_URL — falling
 * back to DATABASE_URL would truncate the developer's own database.
 *
 * Called as an import side effect because jest workers do not inherit the
 * environment globalSetup mutates: globalSetup runs in its own process.
 */
export function loadTestEnv(): void {
  const file = join(SERVER_ROOT, '.env.test');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1];
      if (process.env[key] !== undefined) continue;
      process.env[key] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }

  const url = process.env['TEST_DATABASE_URL'];
  const direct = process.env['TEST_DIRECT_URL'];
  if (!url || !direct) {
    throw new Error(
      'TEST_DATABASE_URL and TEST_DIRECT_URL must be set — see server/.env.test.example. ' +
        'The e2e suite truncates every table it can see, so it never falls back to DATABASE_URL.',
    );
  }

  process.env['DATABASE_URL'] = url;
  process.env['DIRECT_URL'] = direct;

  // No cron jobs inside a test app. `autoCloseVisits` runs every fifteen
  // minutes of REAL time, and a tick landing mid-suite would close a visit a
  // test had just opened (or settle a stale one before the test's own
  // STALE_CLOSE assertion). Nothing in the e2e suite relies on a registered
  // job; a spec that ever needs one can set this back explicitly.
  if (process.env['SCHEDULER_ENABLED'] === undefined) process.env['SCHEDULER_ENABLED'] = 'false';
}

loadTestEnv();

/**
 * Cross-process "already prepared" marker.
 *
 * `globalSetup` runs in its own process; every spec file gets its own fresh
 * module registry (so the in-memory `prepared` flag above resets to false per
 * file) even at `maxWorkers: 1`. Without this, `createTestApp()` re-spawns
 * `prisma migrate deploy` + `prisma db seed` via `execSync` at the top of
 * every single spec file — harmless (both are idempotent) but two wasted CLI
 * subprocesses per file, multiplying with every e2e spec this suite gains.
 *
 * Keyed on a hash of `TEST_DATABASE_URL` rather than a fixed name, so a stale
 * sentinel from a previous scratch database never short-circuits prep against
 * a different one. `globalSetup` always runs the real prep and overwrites
 * this file before any spec file executes, so staleness across separate
 * `npm run test:e2e` invocations is not a concern — only in-run duplication.
 */
function sentinelPath(): string {
  const url = process.env['TEST_DATABASE_URL'] ?? '';
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 16);
  return join(tmpdir(), `got-e2e-prepared-${hash}.json`);
}

/**
 * Runs `migrate deploy` + `db seed` with output captured rather than streamed.
 *
 * Piping instead of inheriting stdio keeps a passing e2e run's console
 * pristine — worthwhile once every spec file no longer re-runs this, since
 * otherwise it was noise repeated per file. On failure the captured
 * stdout/stderr is surfaced on the thrown error so nothing is lost for
 * debugging.
 */
function runPrismaCommand(command: string): void {
  try {
    execSync(command, { cwd: SERVER_ROOT, stdio: 'pipe', env: process.env });
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const output = [err.stdout?.toString(), err.stderr?.toString()].filter(Boolean).join('\n');
    throw new Error(`${command} failed:\n${output || err.message}`);
  }
}

/**
 * Builds the scratch database with `migrate deploy`, never `db push`.
 *
 * `db push` skips the migration SQL, and every CHECK constraint in this design
 * lives in hand-edited migration SQL — so the whole integrity suite would pass
 * against a schema that has none of them. `db seed` runs in the same step
 * because a skipped seed fails closed and silently.
 *
 * Short-circuits on the cross-process sentinel so worker processes (each spec
 * file) skip straight past this once `globalSetup` has already done it for
 * the whole run.
 */
export async function ensureMigratedAndSeeded(): Promise<void> {
  if (prepared) return;
  loadTestEnv();

  if (existsSync(sentinelPath())) {
    prepared = true;
    return Promise.resolve();
  }

  runPrismaCommand('npx prisma migrate deploy');
  runPrismaCommand('npx prisma db seed');

  prepared = true;
  return Promise.resolve();
}

/** Empties every non-seeded table. Cheaper and far more reliable than per-test cleanup. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;

  const targets = rows
    .map((row) => row.tablename)
    .filter((name) => !PRESERVED_TABLES.includes(name))
    .map((name) => `"public"."${name}"`);

  if (targets.length === 0) return;
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${targets.join(', ')} RESTART IDENTITY CASCADE`);
}

/**
 * jest `globalSetup` entry point — runs once for the whole e2e run, in its
 * own process, before any spec file's module registry exists.
 *
 * Always does the real prep (never trusts a leftover sentinel from a prior
 * run) and then writes the sentinel so every spec file's `ensureMigratedAndSeeded`
 * can short-circuit for the rest of this run.
 */
export default function globalSetup(): Promise<void> {
  loadTestEnv();

  const sentinel = sentinelPath();
  if (existsSync(sentinel)) rmSync(sentinel);

  runPrismaCommand('npx prisma migrate deploy');
  runPrismaCommand('npx prisma db seed');

  writeFileSync(sentinel, JSON.stringify({ preparedAt: new Date().toISOString() }));
  return Promise.resolve();
}
