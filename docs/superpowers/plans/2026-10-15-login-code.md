# Login code (password, then an emailed 6-digit code) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every sign-in (members, front desk, coaches, admins, DEV) must enter a 6-digit code emailed through Resend before the API or live chat answers it, except sign-ins that came from an email link and except when the `LOGIN_CODE_REQUIRED` kill switch is off.

**Architecture:** Supabase stays the identity provider. The API reads the signed `session_id` and `amr` claims. One injectable, `LoginGateService`, decides whether a sign-in is verified: a `LoginVerification` row with `verifiedAt`, an email-link `amr`, or the kill switch off. `AuthGuard` and `StationTokenAccessGuard`'s staff path both call it. A new `LoginCodeController` (`/auth/login-code`) issues and checks HMAC-stored codes. A migration adds a `SECURITY DEFINER` function to the Realtime private-channel policy, so chat applies the same rule; it reads the kill switch from a one-row `LoginCodeSetting` table that the API writes at boot. The login page gets a second step, and `apiFetch` sends any page that hits `LOGIN_CODE_REQUIRED` to `/login?next=…`.

**Tech Stack:** NestJS 11, Prisma 6 (folder schema, hand-written SQL migrations), zod env, class-validator, Resend, jose; Next.js 16 client, vitest (jsdom, `react-dom/server` rendering), `@got/shared`.

**Spec:** `docs/superpowers/specs/2026-10-15-login-code-design.md`. It is the binding authority. Read it with this plan.

## Global Constraints

- **`server/.env` points at PRODUCTION.** Never read it, never edit it. Never run `prisma migrate`, `prisma db push`, `prisma db seed`, `npm run db:seed`, `npm run test:e2e`, or any command that opens a database connection.
- **Prisma generate only with dummy URLs:** `DATABASE_URL="postgresql://x:x@localhost:5432/x" DIRECT_URL="postgresql://x:x@localhost:5432/x" npm run prisma:generate --workspace=server`.
- **Never run `npm run lint`.** The server's lint script is `eslint --fix` and rewrites unrelated files.
- **Never push, and never commit to `main`.** Work stays on `feat/login-code`.
- Migrations are hand-written SQL. Every CHECK is named `"<Table>_<rule>"`. Every new table gets `ENABLE ROW LEVEL SECURITY` and a guarded `REVOKE ALL … FROM anon / authenticated` (`DO $rls$` block). Migration folders: `20261015000000_login_verification` and `20261015000100_login_code_realtime`.
- Prettier style: single quotes, trailing commas, 100 columns, LF.
- Every new Nest route takes a class-validator DTO for any body (`ValidationPipe` runs with `whitelist` + `forbidNonWhitelisted`).
- Expected failures are thrown as `DomainException(code, message, status, details?)`, with codes from the closed `DomainErrorCode` union in `shared/src/types/api.types.ts`.
- **Copy is human.** The client never shows a raw error code. Email failure copy, verbatim from the spec: "We couldn't send the email — ask the gym."
- Code rules (spec, verbatim values): six digits from `crypto.randomInt(0, 1_000_000)`, zero-padded; HMAC-SHA256 keyed by `IP_HASH_PEPPER` over `login-code:v1:<sessionId>:<code>`; valid **10 minutes**; **5** wrong attempts burn the code; a new code replaces the old one; resend cooldown **60 seconds**; at most **5 codes per sign-in**; at most **10 codes per account per hour**; constant-time comparison.
- Throttles: send `default` 5/min, `origin` 30/min. Verify `default` 10/min, `origin` 60/min.
- Email subject `Your Gym of Thrones sign-in code: 123456`. Body: the code large, then "It expires in 10 minutes. If you didn't try to sign in, change your password."
- Email-link `amr` methods (each counts as verified): `otp`, `magiclink`, `invite`, `recovery`.
- `LOGIN_CODE_REQUIRED` is the literal string `'true'` or `'false'`, default `'true'`. Never `z.coerce.boolean()`.
- Server tests: `npm test --workspace=server -- <pattern>`. Client tests: `npm test --workspace=client -- <pattern>`. E2E specs are **written, not run** (the owner batches E2E).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Clock skew and time boundaries.** If the API clock is behind the database, a DB-defaulted `createdAt` can land after the app-written `verifiedAt`. That breaks `LoginVerification_verified_after_created` and the person at the counter gets a 500. A code checked at exactly `codeExpiresAt` must count as expired. → Task 6 writes `createdAt` from the app clock, clamps `verifiedAt` to at least `createdAt`, and tests both boundaries.
2. **Two tabs, or a resend racing a verify.** The second tab to verify the same sign-in must get `{ verified: true }`, not "expired". A wrong guess against a code a resend just replaced must not push the new code's attempt count. → Task 6 tests the lost-update paths, which use `updateMany` where-guards.
3. **Pasting a code.** "123 456" pasted into a `maxLength={6}` field is cut off by the browser *before* `onChange` sees it. → Task 8 tests `normaliseCodeInput` and Task 9 handles `onPaste`. Task 7 tests that the DTO accepts "123 456".
4. **Token refresh.** A refreshed access token has a new signature but the same `session_id`. It must stay verified and must never be asked again. → Task 4 tests that the gate keys on `sessionId` only, and that a cached sign-in needs no database query.
5. **Kill switch off, or the setting row missing.** With `LOGIN_CODE_REQUIRED=false` the API gate must open immediately, and a failed `LoginCodeSetting` upsert at boot must be logged, never fatal. If the row is missing, the Realtime function fails closed. → Task 4 tests the sync. Task 2's migration and e2e spec pin the fail-closed `COALESCE`.

---

## File Structure

**Shared**
- Modify `shared/src/types/api.types.ts`: six new `DomainErrorCode` members.
- Create `shared/src/types/login-code.types.ts`: response shapes for the two endpoints.
- Modify `shared/src/index.ts`: export it.

**Server: config and database**
- Modify `server/src/config/env.validation.ts` and its spec: `LOGIN_CODE_REQUIRED`.
- Modify `.env.example`, `server/test/support/db.ts` (test default `'false'`).
- Create `server/prisma/schema/login-verification.prisma` (both models). Modify `server/prisma/schema/user.prisma` (back-relation).
- Create the two migration folders.
- Create `server/test/login-code-constraints.e2e-spec.ts`.

**Server: auth**
- Modify `server/src/auth/auth.types.ts`: `SupabaseClaims.sessionId` and `.amr`, plus a new `AuthSession`.
- Modify `server/src/auth/jwt-verifier.ts` and its spec: parse `session_id` and `amr`.
- Create `server/src/auth/auth-session.ts` and its spec: `authSessionFrom(claims)`, `EMAIL_LINK_AMR_METHODS`.
- Create `server/src/auth/decorators/allow-unverified-login.decorator.ts` and `current-auth-session.decorator.ts`.
- Create `server/src/auth/login-gate.service.ts` and its spec: the single decision point, with the LRU cache.
- Create `server/src/auth/login-code/login-code-setting.sync.ts` and its spec: boot upsert and the misconfiguration log.
- Modify `server/src/auth/auth.guard.ts` and its spec. Modify `server/src/checkin/station.guard.ts`; create `station.guard.spec.ts`.
- Create `server/src/auth/login-code/login-code.constants.ts`, `login-code.crypto.ts` and its spec.
- Modify `server/src/notifications/email.service.ts` and its spec: `sendLoginCode`.
- Create `server/src/auth/login-code/login-code.service.ts` and its spec.
- Create `server/src/auth/login-code/verify-login-code.dto.ts` and its spec, and `login-code.controller.ts` and its spec.
- Modify `server/src/auth/auth.module.ts`.
- Modify `server/src/auth/user-provisioning.service.spec.ts` and `server/test/support/auth-fixture.ts`, so the claims literals carry the new fields.

**Client**
- Create `client/src/lib/loginCodeRedirect.ts` and its test: pure redirect decision plus a spy-able navigation seam.
- Modify `client/src/lib/api.ts` and `api.test.ts`.
- Create `client/src/lib/loginCode.ts` and its test: API calls, copy, countdown, input normalising, `/me` failure classifier.
- Create `client/src/components/auth/LoginCodeStep.tsx` and its test.
- Modify `client/src/components/auth/LoginPage.tsx`.
- `client/src/components/chat/RealtimeProvider.tsx`: **no change.** Its socket effect already returns early while `meId === null` (line 171), and `me` exists only after `/me` succeeds, which needs a verified sign-in.

**Docs**
- `CLAUDE.md`, `docs/deploy.md`.

---

### Task 1: Shared contract and the `LOGIN_CODE_REQUIRED` switch

**Files:**
- Modify: `shared/src/types/api.types.ts` (after `| 'MEMBER_JOIN_STAFF_ACCOUNT'`, around line 276)
- Create: `shared/src/types/login-code.types.ts`
- Modify: `shared/src/index.ts`
- Modify: `server/src/config/env.validation.ts` (after `SCHEDULER_ENABLED`, around line 141)
- Test: `server/src/config/env.validation.spec.ts`
- Modify: `.env.example` (after the `SCHEDULER_ENABLED` block, around line 123)
- Modify: `server/test/support/db.ts` (`loadTestEnv`, after the `SCHEDULER_ENABLED` default)

**Interfaces:**
- Produces: `DomainErrorCode` members `'LOGIN_CODE_REQUIRED' | 'LOGIN_CODE_SEND_LIMIT' | 'LOGIN_CODE_EMAIL_FAILED' | 'LOGIN_CODE_INVALID' | 'LOGIN_CODE_EXPIRED' | 'LOGIN_CODE_LOCKED'`.
- Produces (`@got/shared`): `LoginCodePending { verified: false; sentTo: string; resendAvailableAt: string; expiresAt: string }`, `LoginCodeVerified { verified: true }`, `LoginCodeSendResult = LoginCodePending | LoginCodeVerified`, `LoginCodeInvalidDetails { attemptsLeft: number }`.
- Produces: `Env['LOGIN_CODE_REQUIRED']: boolean`.

- [ ] **Step 1: Write the failing env test**

Append inside `describe('envValidationSchema', …)` in `server/src/config/env.validation.spec.ts`, after the `SCHEDULER_ENABLED` describe:

```ts
  describe('LOGIN_CODE_REQUIRED', () => {
    it('defaults to true — the emailed code is on unless someone turns it off', () => {
      expect(parse().LOGIN_CODE_REQUIRED).toBe(true);
    });

    it("parses the STRING 'false' to boolean false (the kill switch)", () => {
      expect(parse({ LOGIN_CODE_REQUIRED: 'false' }).LOGIN_CODE_REQUIRED).toBe(false);
    });

    it("parses 'true' to boolean true", () => {
      expect(parse({ LOGIN_CODE_REQUIRED: 'true' }).LOGIN_CODE_REQUIRED).toBe(true);
    });

    it('rejects anything else rather than guessing', () => {
      expect(() => parse({ LOGIN_CODE_REQUIRED: '0' })).toThrow(/LOGIN_CODE_REQUIRED/);
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace=server -- env.validation`
Expected: FAIL. `parse().LOGIN_CODE_REQUIRED` is `undefined`.

- [ ] **Step 3: Add the env variable**

In `server/src/config/env.validation.ts`, directly after the `SCHEDULER_ENABLED` entry:

```ts
    // The emailed sign-in code (password, then a 6-digit code, every sign-in).
    // THE KILL SWITCH for when email is broken: 'false' and a restart lets
    // everyone sign in with the password alone. Fail closed by default — with
    // it on and Resend unconfigured nobody can finish signing in, and
    // LoginCodeSettingSync logs an error at boot saying so. NOT
    // z.coerce.boolean(), which maps the string "false" to true.
    LOGIN_CODE_REQUIRED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace=server -- env.validation`
Expected: PASS.

- [ ] **Step 5: Add the shared error codes and types**

In `shared/src/types/api.types.ts`, directly after the line `  | 'MEMBER_JOIN_STAFF_ACCOUNT'`:

```ts
  // ── Sign-in code (feat/login-code) ──────────────────────────────────────────
  // 401 on every authenticated route except the two /auth/login-code routes
  // while this sign-in has not entered its emailed code. apiFetch sends the
  // browser to /login?next=…, and the login page shows the code step.
  | 'LOGIN_CODE_REQUIRED'
  // 429. Five codes for this sign-in, or ten for this account in an hour.
  | 'LOGIN_CODE_SEND_LIMIT'
  // 503. Resend refused or is not configured. The send is not counted.
  | 'LOGIN_CODE_EMAIL_FAILED'
  // 422. `details` is LoginCodeInvalidDetails (`{ attemptsLeft }`).
  | 'LOGIN_CODE_INVALID'
  // 422. Past its 10 minutes, replaced by a newer code, or never sent.
  | 'LOGIN_CODE_EXPIRED'
  // 422. Five wrong guesses burned this code until a new one is requested.
  | 'LOGIN_CODE_LOCKED'
```

Create `shared/src/types/login-code.types.ts`:

```ts
/**
 * The emailed sign-in code (feat/login-code, 2026-10-15): password, then a
 * 6-digit code, on every sign-in. Spec:
 * docs/superpowers/specs/2026-10-15-login-code-design.md.
 */

/** `POST /auth/login-code` when a code is (or was just) on its way. */
export interface LoginCodePending {
  verified: false;
  /** Masked, e.g. `ju***@gmail.com`. */
  sentTo: string;
  /** ISO instant. Until then "Resend code" counts down. */
  resendAvailableAt: string;
  /** ISO instant the current code stops working. */
  expiresAt: string;
}

/** Either endpoint, once this sign-in is verified. */
export interface LoginCodeVerified {
  verified: true;
}

export type LoginCodeSendResult = LoginCodePending | LoginCodeVerified;

/** `error.details` of `422 LOGIN_CODE_INVALID`. */
export interface LoginCodeInvalidDetails {
  attemptsLeft: number;
}
```

In `shared/src/index.ts`, after the `member-join.types` export:

```ts
// The emailed sign-in code: the two /auth/login-code responses.
export * from './types/login-code.types';
```

- [ ] **Step 6: Document the variable and default it off in the e2e harness**

In `.env.example`, after the `SCHEDULER_ENABLED="true"` line:

```bash

# The emailed sign-in code: password, then a 6-digit code, on every sign-in.
# Literal string 'true'/'false'; UNSET MEANS 'true'. This is the KILL SWITCH:
# if email breaks (Resend misconfigured, daily quota hit), set 'false' on the
# API host and restart, and everyone signs in with the password alone until
# it is fixed. With it on and RESEND_API_KEY/RESEND_FROM unset, nobody can
# finish signing in — the API logs an error at boot. 'false' here because a
# local copy of this file usually has no Resend key; production sets 'true'.
LOGIN_CODE_REQUIRED="false"
```

In `server/test/support/db.ts`, directly after the `SCHEDULER_ENABLED` default line inside `loadTestEnv()`:

```ts
  // The emailed sign-in code is OFF inside a test app unless a spec turns it
  // on: fixture tokens are password sign-ins with no LoginVerification row, so
  // the gate would answer every request 401 LOGIN_CODE_REQUIRED.
  if (process.env['LOGIN_CODE_REQUIRED'] === undefined) {
    process.env['LOGIN_CODE_REQUIRED'] = 'false';
  }
```

- [ ] **Step 7: Build shared to prove the union and barrel compile**

Run: `npm run build --workspace=shared`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add shared/src/types/api.types.ts shared/src/types/login-code.types.ts shared/src/index.ts server/src/config/env.validation.ts server/src/config/env.validation.spec.ts .env.example server/test/support/db.ts
git commit -m "feat(login-code): error codes, response types and the LOGIN_CODE_REQUIRED switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Database — `LoginVerification`, `LoginCodeSetting`, the Realtime rule

**Files:**
- Create: `server/prisma/schema/login-verification.prisma`
- Modify: `server/prisma/schema/user.prisma` (after `memberJoinLinksIssued`, line 151)
- Create: `server/prisma/schema/migrations/20261015000000_login_verification/migration.sql`
- Create: `server/prisma/schema/migrations/20261015000100_login_code_realtime/migration.sql`
- Test: `server/test/login-code-constraints.e2e-spec.ts` (written, NOT run)

**Interfaces:**
- Produces (Prisma client): `prisma.loginVerification` with fields `sessionId: string` (PK), `userId: string`, `codeHash: string | null`, `codeExpiresAt: Date | null`, `attempts: number`, `sendCount: number`, `lastSentAt: Date | null`, `verifiedAt: Date | null`, `createdAt: Date`; `prisma.loginCodeSetting` with `id: number` (always 1), `required: boolean`, `updatedAt: Date`.
- Produces (SQL): `public.login_session_verified() RETURNS boolean`. It exists only where `auth.jwt()` exists (Supabase), and the Realtime policy `"user reads own private channel"` calls it.

- [ ] **Step 1: Write the e2e spec (it runs later, in the owner's batch)**

Create `server/test/login-code-constraints.e2e-spec.ts`:

```ts
import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

const MEMBER_SUPABASE_ID = '65000000-0000-4000-8000-0000000000c1';
const SESSION = '65000000-0000-4000-8000-00000000005e';
const HASH = 'a'.repeat(64);

/**
 * The emailed sign-in code, asserted at the DATABASE (feat/login-code,
 * migrations 20261015000000_login_verification and
 * 20261015000100_login_code_realtime).
 *
 * Every rule here lives only in hand-written migration SQL: a `db push` or a
 * regenerated migration would drop it silently while every service test kept
 * passing.
 *
 * Written 2026-10-15 under the owner's batch-E2E rule and not yet run against
 * Postgres: the predicate strings are what `pg_get_constraintdef` is expected
 * to print, and are the first thing to check if this suite fails on its first run.
 */
describe('CHECK constraints — login code (e2e)', () => {
  let ctx: TestApp;
  let memberId: string;

  const definitionOf = async (name: string): Promise<string> => {
    const rows = await ctx.prisma.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}
    `;
    expect(rows).toHaveLength(1);
    return rows[0].def;
  };

  const checksOn = async (table: string): Promise<string[]> => {
    const rows = await ctx.prisma.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"${table}"'::regclass AND contype = 'c'`,
    );
    return rows.map((row) => row.conname).sort();
  };

  /** One sign-in row with every column valid; `over` is raw SQL per column. */
  const insertRow = (over: Record<string, string> = {}): Promise<number> => {
    const columns: Record<string, string> = {
      '"sessionId"': `'${SESSION}'`,
      '"userId"': `'${memberId}'`,
      '"codeHash"': `'${HASH}'`,
      '"codeExpiresAt"': `'2026-10-15T00:10:00Z'`,
      attempts: '0',
      '"sendCount"': '1',
      '"lastSentAt"': `'2026-10-15T00:00:00Z'`,
      '"createdAt"': `'2026-10-15T00:00:00Z'`,
      ...over,
    };
    return ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "LoginVerification" (${Object.keys(columns).join(', ')})
       VALUES (${Object.values(columns).join(', ')})`,
    );
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: MEMBER_SUPABASE_ID });
    memberId = await ctx.fixture.userIdFor(MEMBER_SUPABASE_ID);
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "LoginVerification"');
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "LoginCodeSetting"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('presence', () => {
    it('names exactly the LoginVerification CHECKs the migration wrote', async () => {
      expect(await checksOn('LoginVerification')).toEqual([
        'LoginVerification_attempts_range',
        'LoginVerification_code_hash_shape',
        'LoginVerification_code_pair',
        'LoginVerification_send_count_range',
        'LoginVerification_verified_after_created',
      ]);
      expect(await checksOn('LoginCodeSetting')).toEqual(['LoginCodeSetting_single_row']);
    });

    it('asserts each PREDICATE, not just the name', async () => {
      expect(await definitionOf('LoginVerification_code_hash_shape')).toBe(
        `CHECK ((("codeHash" IS NULL) OR ("codeHash" ~ '^[0-9a-f]{64}$'::text)))`,
      );
      expect(await definitionOf('LoginVerification_attempts_range')).toBe(
        'CHECK (((attempts >= 0) AND (attempts <= 5)))',
      );
      expect(await definitionOf('LoginVerification_send_count_range')).toBe(
        'CHECK ((("sendCount" >= 0) AND ("sendCount" <= 5)))',
      );
      expect(await definitionOf('LoginVerification_code_pair')).toBe(
        'CHECK ((("codeHash" IS NULL) = ("codeExpiresAt" IS NULL)))',
      );
      expect(await definitionOf('LoginVerification_verified_after_created')).toBe(
        'CHECK ((("verifiedAt" IS NULL) OR ("verifiedAt" >= "createdAt")))',
      );
      expect(await definitionOf('LoginCodeSetting_single_row')).toBe('CHECK ((id = 1))');
    });

    it('has RLS enabled on both tables', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
        SELECT relname, relrowsecurity FROM pg_class
         WHERE relname IN ('LoginVerification', 'LoginCodeSetting') ORDER BY relname
      `;
      expect(rows).toEqual([
        { relname: 'LoginCodeSetting', relrowsecurity: true },
        { relname: 'LoginVerification', relrowsecurity: true },
      ]);
    });

    it('cascades with its user and indexes userId', async () => {
      const fks = await ctx.prisma.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
        SELECT conname, confdeltype FROM pg_constraint
         WHERE conrelid = '"LoginVerification"'::regclass AND contype = 'f'
      `;
      expect(fks).toEqual([{ conname: 'LoginVerification_userId_fkey', confdeltype: 'c' }]);

      const indexes = await ctx.prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'LoginVerification' ORDER BY indexname
      `;
      expect(indexes.map((row) => row.indexname)).toEqual([
        'LoginVerification_pkey',
        'LoginVerification_userId_idx',
      ]);
    });
  });

  describe('LoginVerification rules', () => {
    it('accepts a valid row (positive control)', async () => {
      await expect(insertRow()).resolves.toBe(1);
    });

    it('accepts a verified row with the code cleared', async () => {
      await expect(
        insertRow({
          '"codeHash"': 'NULL',
          '"codeExpiresAt"': 'NULL',
          '"verifiedAt"': `'2026-10-15T00:01:00Z'`,
        }),
      ).resolves.toBe(1);
    });

    it('refuses a hash that is not 64 lower-case hex characters', async () => {
      await expect(insertRow({ '"codeHash"': `'${'A'.repeat(64)}'` })).rejects.toThrow(
        /LoginVerification_code_hash_shape/,
      );
    });

    it('refuses a hash without an expiry, and an expiry without a hash', async () => {
      await expect(insertRow({ '"codeExpiresAt"': 'NULL' })).rejects.toThrow(
        /LoginVerification_code_pair/,
      );
      await expect(insertRow({ '"codeHash"': 'NULL' })).rejects.toThrow(
        /LoginVerification_code_pair/,
      );
    });

    it('refuses attempts outside 0..5', async () => {
      await expect(insertRow({ attempts: '6' })).rejects.toThrow(/LoginVerification_attempts_range/);
      await expect(insertRow({ attempts: '-1' })).rejects.toThrow(
        /LoginVerification_attempts_range/,
      );
    });

    it('refuses a send count outside 0..5', async () => {
      await expect(insertRow({ '"sendCount"': '6' })).rejects.toThrow(
        /LoginVerification_send_count_range/,
      );
    });

    it('refuses a verification before the row existed', async () => {
      await expect(insertRow({ '"verifiedAt"': `'2026-10-14T23:59:59Z'` })).rejects.toThrow(
        /LoginVerification_verified_after_created/,
      );
    });
  });

  describe('LoginCodeSetting', () => {
    it('holds one row, id 1', async () => {
      await ctx.prisma.$executeRawUnsafe(
        `INSERT INTO "LoginCodeSetting" (id, required, "updatedAt") VALUES (1, true, now())`,
      );
      await expect(
        ctx.prisma.$executeRawUnsafe(
          `INSERT INTO "LoginCodeSetting" (id, required, "updatedAt") VALUES (2, false, now())`,
        ),
      ).rejects.toThrow(/LoginCodeSetting_single_row/);
    });
  });

  /**
   * The Realtime half is GUARDED: plain Postgres (this harness) has no
   * `realtime` or `auth` schema, so it must be a no-op there. On a Supabase
   * scratch project the policy must call the verification function.
   */
  describe('Realtime policy', () => {
    it('applied the migration, and the policy calls login_session_verified() where Realtime exists', async () => {
      const [applied] = await ctx.prisma.$queryRaw<Array<{ done: boolean }>>`
        SELECT finished_at IS NOT NULL AND rolled_back_at IS NULL AS done
          FROM _prisma_migrations
         WHERE migration_name = '20261015000100_login_code_realtime'
      `;
      expect(applied?.done).toBe(true);

      const [probe] = await ctx.prisma.$queryRaw<Array<{ table: string | null }>>`
        SELECT to_regclass('realtime.messages')::text AS "table"
      `;

      const fn = await ctx.prisma.$queryRaw<Array<{ prosecdef: boolean }>>`
        SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'login_session_verified'
      `;

      if (probe.table === null) {
        expect(fn).toEqual([]);
        return;
      }

      expect(fn).toEqual([{ prosecdef: true }]);
      const [policy] = await ctx.prisma.$queryRaw<Array<{ qual: string }>>`
        SELECT qual FROM pg_policies
         WHERE schemaname = 'realtime' AND tablename = 'messages'
           AND policyname = 'user reads own private channel'
      `;
      expect(policy.qual).toContain(`realtime.topic()`);
      expect(policy.qual).toContain(`auth.uid()`);
      expect(policy.qual).toContain(`'broadcast'::text`);
      expect(policy.qual).toContain('login_session_verified()');
    });
  });
});
```

- [ ] **Step 2: Add the Prisma models**

Create `server/prisma/schema/login-verification.prisma`:

```prisma
/// One Supabase sign-in's emailed code (feat/login-code, 2026-10-15).
/// ONE ROW PER SIGN-IN, keyed by the token's `session_id`, which every
/// refreshed token of that sign-in repeats.
///
/// Only an HMAC of the code is stored (key IP_HASH_PEPPER, domain-separated by
/// session id), and it is cleared on a successful verify.
///
/// The CHECKs (hash shape, attempts 0..5, sendCount 0..5, hash and expiry
/// together, verified not before created) live only in migration
/// 20261015000000_login_verification — Prisma cannot represent them.
model LoginVerification {
  sessionId     String    @id @db.Uuid
  userId        String    @db.Uuid
  codeHash      String?   @db.Char(64)
  codeExpiresAt DateTime? @db.Timestamptz(3)
  /// Wrong guesses against the CURRENT code. 5 burns it.
  attempts      Int       @default(0)
  /// Codes sent for this sign-in. 5 is the ceiling.
  sendCount     Int       @default(0)
  lastSentAt    DateTime? @db.Timestamptz(3)
  verifiedAt    DateTime? @db.Timestamptz(3)
  createdAt     DateTime  @default(now()) @db.Timestamptz(3)

  user User @relation("LoginVerificationUser", fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}

/// The API's LOGIN_CODE_REQUIRED, mirrored for the Realtime policy (which
/// cannot read env). ONE ROW: id 1. Written by LoginCodeSettingSync at every
/// boot. A missing row reads as "required" (fail closed).
///
/// The single-row CHECK lives only in migration 20261015000100_login_code_realtime.
model LoginCodeSetting {
  id        Int      @id @default(1)
  required  Boolean
  updatedAt DateTime @updatedAt @db.Timestamptz(3)
}
```

In `server/prisma/schema/user.prisma`, directly after `  memberJoinLinksIssued MemberJoinLink[] @relation("MemberJoinLinkIssuedBy")`:

```prisma
  loginVerifications    LoginVerification[] @relation("LoginVerificationUser")
```

- [ ] **Step 3: Write migration 1**

Create `server/prisma/schema/migrations/20261015000000_login_verification/migration.sql`:

```sql
-- The emailed sign-in code (feat/login-code, 2026-10-15).
--
-- Hand-written: prisma migrate dev refuses on the shared dev DB (checksum drift).
-- ADDITIVE ONLY: one new table. main's code never reads it, so it keeps running
-- against this schema during the deploy window.
--
-- Every CHECK below lives ONLY here — Prisma cannot represent them — so
-- test/login-code-constraints.e2e-spec.ts asserts each name AND predicate.

-- ONE ROW PER SUPABASE SIGN-IN, keyed by the access token's `session_id`.
CREATE TABLE "LoginVerification" (
    "sessionId"     UUID           NOT NULL,
    "userId"        UUID           NOT NULL,
    "codeHash"      CHAR(64),
    "codeExpiresAt" TIMESTAMPTZ(3),
    "attempts"      INTEGER        NOT NULL DEFAULT 0,
    "sendCount"     INTEGER        NOT NULL DEFAULT 0,
    "lastSentAt"    TIMESTAMPTZ(3),
    "verifiedAt"    TIMESTAMPTZ(3),
    "createdAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginVerification_pkey" PRIMARY KEY ("sessionId")
);

-- The per-account hourly ceiling sums this user's rows.
CREATE INDEX "LoginVerification_userId_idx" ON "LoginVerification"("userId");

-- CASCADE: a sign-in's code is meaningless without its account.
ALTER TABLE "LoginVerification" ADD CONSTRAINT "LoginVerification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- HMAC-SHA256, hex. Never the code itself.
ALTER TABLE "LoginVerification" ADD CONSTRAINT "LoginVerification_code_hash_shape"
    CHECK ("codeHash" IS NULL OR "codeHash" ~ '^[0-9a-f]{64}$');

-- Five wrong guesses burn the code (LOGIN_CODE_MAX_ATTEMPTS).
ALTER TABLE "LoginVerification" ADD CONSTRAINT "LoginVerification_attempts_range"
    CHECK ("attempts" BETWEEN 0 AND 5);

-- Five codes per sign-in (LOGIN_CODE_MAX_SENDS_PER_SIGN_IN).
ALTER TABLE "LoginVerification" ADD CONSTRAINT "LoginVerification_send_count_range"
    CHECK ("sendCount" BETWEEN 0 AND 5);

-- A live code always has an expiry; a cleared one has neither.
ALTER TABLE "LoginVerification" ADD CONSTRAINT "LoginVerification_code_pair"
    CHECK (("codeHash" IS NULL) = ("codeExpiresAt" IS NULL));

-- The API writes both from its own clock and clamps verifiedAt to createdAt, so
-- a clock-skewed database default can never trip this.
ALTER TABLE "LoginVerification" ADD CONSTRAINT "LoginVerification_verified_after_created"
    CHECK ("verifiedAt" IS NULL OR "verifiedAt" >= "createdAt");

-- Lock it like every other table. ENABLE (not FORCE) leaves the server's
-- BYPASSRLS role unaffected.
ALTER TABLE "LoginVerification" ENABLE ROW LEVEL SECURITY;

-- Guarded: `anon` and `authenticated` do not exist in the plain Postgres the e2e
-- harness builds from these migrations.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "LoginVerification" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "LoginVerification" FROM authenticated';
  END IF;
END
$rls$;
```

- [ ] **Step 4: Write migration 2**

Create `server/prisma/schema/migrations/20261015000100_login_code_realtime/migration.sql`:

```sql
-- The emailed sign-in code, applied to live chat (feat/login-code, 2026-10-15).
--
-- The browser subscribes to Supabase Realtime directly with its own token, so
-- the API's gate never sees it. This adds the same rule to the private-channel
-- policy from 20260929000200_realtime_private_channels: the subscribing
-- sign-in must be verified.
--
-- ── 1. The kill switch, readable from SQL ───────────────────────────────────
-- A policy cannot read the API's env, so the API writes LOGIN_CODE_REQUIRED
-- here at every boot (LoginCodeSettingSync). Seeded 'true': fail closed until
-- the API says otherwise.
CREATE TABLE "LoginCodeSetting" (
    "id"        INTEGER        NOT NULL DEFAULT 1,
    "required"  BOOLEAN        NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LoginCodeSetting_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LoginCodeSetting" ADD CONSTRAINT "LoginCodeSetting_single_row"
    CHECK ("id" = 1);

INSERT INTO "LoginCodeSetting" ("id", "required", "updatedAt")
VALUES (1, true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "LoginCodeSetting" ENABLE ROW LEVEL SECURITY;

DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "LoginCodeSetting" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "LoginCodeSetting" FROM authenticated';
  END IF;
END
$rls$;

-- ── 2. The verification check, and the policy that uses it ──────────────────
-- SECURITY DEFINER because the policy runs as `authenticated`, which has had
-- ALL revoked on both tables above (and RLS with no policy would return no
-- rows anyway). The function reveals one boolean about the CALLER'S OWN
-- sign-in. `search_path = ''` and schema-qualified names stop a caller from
-- shadowing anything. A missing setting row reads as required (fail closed).
-- A `session_id` that is not a uuid is never cast (a bad cast would RAISE).
--
-- The email-link methods match EMAIL_LINK_AMR_METHODS in
-- server/src/auth/auth-session.ts. Change both together.
--
-- GUARDED like 20260929000200: a no-op on plain Postgres (no `auth`/`realtime`
-- schema), and it WARNS rather than fails on insufficient privilege, because a
-- failed migration blocks every later deploy (P3009). DROP and CREATE share
-- one sub-transaction, so a failed CREATE never leaves chat with no policy at
-- all. If it warns, the owner runs the statements below in the Supabase SQL
-- editor.
DO $realtime$
BEGIN
  IF to_regclass('realtime.messages') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'realtime' AND p.proname = 'topic'
     )
     AND EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'auth' AND p.proname = 'uid'
     )
     AND EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'auth' AND p.proname = 'jwt'
     )
  THEN
    BEGIN
      EXECUTE $fn$
        CREATE OR REPLACE FUNCTION public.login_session_verified() RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
        AS $body$
          SELECT
            COALESCE((SELECT NOT s."required" FROM public."LoginCodeSetting" s WHERE s."id" = 1), false)
            OR EXISTS (
              SELECT 1 FROM public."LoginVerification" v
               WHERE v."verifiedAt" IS NOT NULL
                 AND v."sessionId" = CASE
                   WHEN (auth.jwt() ->> 'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   THEN (auth.jwt() ->> 'session_id')::uuid
                 END
            )
            OR EXISTS (
              SELECT 1
                FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(auth.jwt() -> 'amr') = 'array'
                            THEN auth.jwt() -> 'amr' ELSE '[]'::jsonb END
                     ) AS a(elem)
               WHERE lower(COALESCE(a.elem ->> 'method', a.elem #>> '{}'))
                     IN ('otp', 'magiclink', 'invite', 'recovery')
            )
        $body$
      $fn$;
      EXECUTE 'REVOKE ALL ON FUNCTION public.login_session_verified() FROM PUBLIC';
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON FUNCTION public.login_session_verified() FROM anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.login_session_verified() TO authenticated';
      END IF;

      EXECUTE 'DROP POLICY IF EXISTS "user reads own private channel" ON realtime.messages';
      EXECUTE $p$CREATE POLICY "user reads own private channel" ON realtime.messages
        FOR SELECT TO authenticated
        USING (
          realtime.topic() = 'user:' || auth.uid()::text
          AND extension = 'broadcast'
          AND public.login_session_verified()
        )$p$;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE WARNING 'login-code realtime rule NOT applied (insufficient privilege) — run migration 20261015000100_login_code_realtime''s function and policy in the Supabase SQL editor';
    END;
  END IF;
END
$realtime$;
```

- [ ] **Step 5: Generate the client with dummy URLs**

Run: `DATABASE_URL="postgresql://x:x@localhost:5432/x" DIRECT_URL="postgresql://x:x@localhost:5432/x" npm run prisma:generate --workspace=server`
Expected: "Generated Prisma Client", with no schema validation error (a missing back-relation on `User` fails here).

- [ ] **Step 6: Typecheck the server against the new client**

Run: `npm run typecheck --workspace=server` (shared was built in Task 1, Step 7).
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/prisma/schema/login-verification.prisma server/prisma/schema/user.prisma server/prisma/schema/migrations/20261015000000_login_verification server/prisma/schema/migrations/20261015000100_login_code_realtime server/test/login-code-constraints.e2e-spec.ts
git commit -m "feat(login-code): LoginVerification and LoginCodeSetting tables, Realtime policy rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Read `session_id` and `amr` from the token

**Files:**
- Modify: `server/src/auth/auth.types.ts`
- Modify: `server/src/auth/jwt-verifier.ts` (in `verifyAccessToken`, after the `sub` check)
- Test: `server/src/auth/jwt-verifier.spec.ts`
- Create: `server/src/auth/auth-session.ts`
- Test: `server/src/auth/auth-session.spec.ts`
- Modify: `server/src/auth/user-provisioning.service.spec.ts:6-15` (CLAIMS literal)
- Modify: `server/src/auth/auth.guard.spec.ts:8-17` (CLAIMS literal only; the guard changes in Task 4)
- Modify: `server/test/support/auth-fixture.ts` (`tokenFor`)

**Interfaces:**
- Produces: `SupabaseClaims.sessionId: string` (lower-case uuid), `SupabaseClaims.amr: string[]` (lower-case method names).
- Produces: `interface AuthSession { sessionId: string; viaEmailLink: boolean }` in `auth.types.ts`.
- Produces: `EMAIL_LINK_AMR_METHODS: readonly string[]` and `authSessionFrom(claims: Pick<SupabaseClaims, 'sessionId' | 'amr'>): AuthSession` in `server/src/auth/auth-session.ts`.

- [ ] **Step 1: Write the failing claim-parsing tests**

In `server/src/auth/jwt-verifier.spec.ts`, add a constant under `ISSUER`:

```ts
const SESSION_ID = '99999999-9999-4999-8999-999999999999';
```

Change the `sign` helper's first line so that every token carries a sign-in id unless a test overrides it:

```ts
  return new SignJWT({ session_id: SESSION_ID, ...payload })
```

In `it('extracts claims from a valid token', …)`, extend the expected object with:

```ts
      sessionId: SESSION_ID,
      amr: [],
```

Append a new describe at the end of the file:

```ts
/**
 * The emailed sign-in code keys on the sign-in (`session_id`, one per sign-in
 * and unchanged by refresh) and trusts an email-link sign-in by its `amr`.
 * Both are signed by Supabase.
 */
describe('verifyAccessToken — sign-in claims', () => {
  const base = { sub: '11111111-1111-1111-1111-111111111111', email: 'juan@example.com' };

  it('keeps session_id and the amr method names, in order', async () => {
    const token = await sign({
      ...base,
      amr: [
        { method: 'password', timestamp: 1_700_000_000 },
        { method: 'otp', timestamp: 1_700_000_100 },
      ],
    });
    const claims = await verifyAccessToken(token, keys, ISSUER);
    expect(claims.sessionId).toBe(SESSION_ID);
    expect(claims.amr).toEqual(['password', 'otp']);
  });

  it('lower-cases the session id and the methods, so cache keys and comparisons agree', async () => {
    const token = await sign({
      ...base,
      session_id: SESSION_ID.toUpperCase(),
      amr: [{ method: 'MagicLink' }],
    });
    const claims = await verifyAccessToken(token, keys, ISSUER);
    expect(claims.sessionId).toBe(SESSION_ID);
    expect(claims.amr).toEqual(['magiclink']);
  });

  it('accepts amr entries given as bare strings', async () => {
    const token = await sign({ ...base, amr: ['recovery'] });
    expect((await verifyAccessToken(token, keys, ISSUER)).amr).toEqual(['recovery']);
  });

  it.each<[unknown, string]>([
    [undefined, 'absent'],
    ['password', 'a string, not a list'],
    [42, 'a number'],
    [[null, { method: 7 }, { nope: 'otp' }, ''], 'entries with no usable method'],
  ])('reads %p (%s) as no methods', async (amr) => {
    const token = await sign({ ...base, amr });
    expect((await verifyAccessToken(token, keys, ISSUER)).amr).toEqual([]);
  });

  it('refuses a token without session_id — an unidentifiable sign-in cannot be verified', async () => {
    const token = await sign({ ...base, session_id: undefined });
    await expect(verifyAccessToken(token, keys, ISSUER)).rejects.toThrow('missing session_id');
  });

  it('refuses a session_id that is not a uuid', async () => {
    const token = await sign({ ...base, session_id: 'not-a-uuid' });
    await expect(verifyAccessToken(token, keys, ISSUER)).rejects.toThrow('missing session_id');
  });
});
```

Create `server/src/auth/auth-session.spec.ts`:

```ts
import { EMAIL_LINK_AMR_METHODS, authSessionFrom } from './auth-session';

const SESSION_ID = '99999999-9999-4999-8999-999999999999';

describe('authSessionFrom', () => {
  it('carries the sign-in id through', () => {
    expect(authSessionFrom({ sessionId: SESSION_ID, amr: ['password'] }).sessionId).toBe(SESSION_ID);
  });

  it.each(['otp', 'magiclink', 'invite', 'recovery'])(
    "treats '%s' as an email-link sign-in, even after a password step",
    (method) => {
      expect(authSessionFrom({ sessionId: SESSION_ID, amr: ['password', method] }).viaEmailLink).toBe(
        true,
      );
    },
  );

  it.each([[[]], [['password']], [['oauth']], [['totp']], [['token_refresh']]])(
    'does not treat %p as an email link',
    (amr) => {
      expect(authSessionFrom({ sessionId: SESSION_ID, amr }).viaEmailLink).toBe(false);
    },
  );

  it('lists exactly the four methods the Realtime migration also lists', () => {
    expect([...EMAIL_LINK_AMR_METHODS].sort()).toEqual(['invite', 'magiclink', 'otp', 'recovery']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test --workspace=server -- jwt-verifier auth-session`
Expected: FAIL. `auth-session` cannot be resolved, and `sessionId`/`amr` are undefined.

- [ ] **Step 3: Extend the types**

In `server/src/auth/auth.types.ts`, add to `SupabaseClaims` after `dateOfBirth`:

```ts
  /**
   * The Supabase sign-in this token belongs to (`session_id`, lower-case
   * uuid). One per sign-in, repeated by every refreshed token of it. A token
   * without one is refused: a sign-in we cannot identify cannot be verified.
   */
  sessionId: string;
  /** `amr` method names, lower-case: how this sign-in happened ('password', 'otp', …). */
  amr: string[];
```

Append to the file:

```ts
/**
 * The sign-in behind a request, attached by AuthGuard as `request.authSession`
 * beside `request.user`. The emailed-code gate keys on `sessionId`.
 */
export interface AuthSession {
  sessionId: string;
  /** Created by a link opened in the inbox (magic link, invite, password reset). */
  viaEmailLink: boolean;
}
```

- [ ] **Step 4: Parse the claims**

In `server/src/auth/jwt-verifier.ts`, add these helpers above `verifyAccessToken`:

```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sign-in id, lower-cased, or null when absent or not a uuid. */
function asSessionId(value: unknown): string | null {
  const raw = asString(value);
  return raw !== null && UUID.test(raw) ? raw.toLowerCase() : null;
}

/**
 * `amr` method names. Supabase sends `[{ method, timestamp }]`; a bare string
 * entry is accepted too. Anything unusable is dropped, never guessed at.
 */
function asAmrMethods(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const methods: string[] = [];
  for (const entry of value) {
    const method =
      typeof entry === 'string'
        ? entry
        : entry !== null && typeof entry === 'object'
          ? (entry as { method?: unknown }).method
          : undefined;
    if (typeof method === 'string' && method.trim() !== '') {
      methods.push(method.trim().toLowerCase());
    }
  }
  return methods;
}
```

In `verifyAccessToken`, directly after `if (!sub) throw new Error('Invalid token: missing sub claim');`:

```ts
  const sessionId = asSessionId(payload['session_id']);
  if (!sessionId) throw new Error('Invalid token: missing session_id claim');
```

In the returned object, after `dateOfBirth: …,`:

```ts
    sessionId,
    amr: asAmrMethods(payload['amr']),
```

Create `server/src/auth/auth-session.ts`:

```ts
import type { AuthSession, SupabaseClaims } from './auth.types';

/**
 * `amr` methods that prove the person opened a link in the inbox — exactly
 * what the emailed code proves (spec Ruling A). `otp` is the magic link (the
 * counter setup link), `invite` the staff invitation, `recovery` the password
 * reset. Supabase has reported a magic link as both `otp` and `magiclink`.
 *
 * The Realtime migration 20261015000100_login_code_realtime lists the same
 * four. Change both together.
 */
export const EMAIL_LINK_AMR_METHODS: readonly string[] = ['otp', 'magiclink', 'invite', 'recovery'];

/** The sign-in behind a verified token, as the gate needs it. */
export function authSessionFrom(claims: Pick<SupabaseClaims, 'sessionId' | 'amr'>): AuthSession {
  return {
    sessionId: claims.sessionId,
    viaEmailLink: claims.amr.some((method) => EMAIL_LINK_AMR_METHODS.includes(method)),
  };
}
```

- [ ] **Step 5: Bring every hand-built claims literal up to date**

In `server/src/auth/user-provisioning.service.spec.ts` and `server/src/auth/auth.guard.spec.ts`, add to the `CLAIMS` literal after `dateOfBirth: null,`:

```ts
  sessionId: '99999999-9999-4999-8999-999999999999',
  amr: ['password'],
```

In `server/test/support/auth-fixture.ts`, add `import { randomUUID } from 'node:crypto';` at the top. In `tokenFor`, add after `const supabaseId = …`:

```ts
    // A fresh sign-in per token, made by password — what a real login is.
    // The e2e harness turns the emailed-code gate off (support/db.ts); a spec
    // that turns it on must verify this session first.
    const sessionId = randomUUID();
```

Add to the `claims` literal after `dateOfBirth: null,`:

```ts
      sessionId,
      amr: ['password'],
```

Change the `new SignJWT({ … })` payload to:

```ts
    return new SignJWT({
      email: claims.email,
      user_metadata: { firstName: claims.firstName, lastName: claims.lastName },
      session_id: sessionId,
      amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }],
    })
```

- [ ] **Step 6: Run the auth suite to verify everything passes**

Run: `npm test --workspace=server -- src/auth`
Expected: PASS (jwt-verifier, auth-session, user-provisioning, auth.guard, supabase-admin).

- [ ] **Step 7: Commit**

```bash
git add server/src/auth/auth.types.ts server/src/auth/jwt-verifier.ts server/src/auth/jwt-verifier.spec.ts server/src/auth/auth-session.ts server/src/auth/auth-session.spec.ts server/src/auth/user-provisioning.service.spec.ts server/src/auth/auth.guard.spec.ts server/test/support/auth-fixture.ts
git commit -m "feat(login-code): read session_id and amr from the Supabase token

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The gate — `LoginGateService`, both guards, boot sync

**Files:**
- Create: `server/src/auth/decorators/allow-unverified-login.decorator.ts`
- Create: `server/src/auth/login-gate.service.ts`
- Test: `server/src/auth/login-gate.service.spec.ts`
- Create: `server/src/auth/login-code/login-code-setting.sync.ts`
- Test: `server/src/auth/login-code/login-code-setting.sync.spec.ts`
- Modify: `server/src/auth/auth.guard.ts`
- Test: `server/src/auth/auth.guard.spec.ts`
- Modify: `server/src/checkin/station.guard.ts`
- Test: `server/src/checkin/station.guard.spec.ts` (new)
- Modify: `server/src/auth/auth.module.ts`

**Interfaces:**
- Consumes: `AuthSession`, `authSessionFrom` (Task 3); `Env['LOGIN_CODE_REQUIRED']` (Task 1); `prisma.loginVerification`, `prisma.loginCodeSetting` (Task 2); `EmailService.enabled` (existing).
- Produces: `ALLOW_UNVERIFIED_LOGIN_KEY = 'allowUnverifiedLogin'`, `AllowUnverifiedLogin(): MethodDecorator & ClassDecorator`.
- Produces: `LoginGateService` with `readonly required: boolean`, `isVerified(session: AuthSession): Promise<boolean>`, `remember(sessionId: string): void`, `assertVerified(session: AuthSession, exempt: boolean): Promise<void>` (throws `DomainException('LOGIN_CODE_REQUIRED', …, 401)`); `VERIFIED_SESSION_CACHE_SIZE = 10_000`.
- Produces: `LoginCodeSettingSync` (`OnModuleInit`).
- Produces: `request.authSession: AuthSession` on every authenticated request; `RequestWithStationAccess.authSession?: AuthSession`.

- [ ] **Step 1: Write the failing gate tests**

Create `server/src/auth/login-gate.service.spec.ts`:

```ts
import { HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthSession } from './auth.types';
import { LoginGateService, VERIFIED_SESSION_CACHE_SIZE } from './login-gate.service';

const SESSION: AuthSession = {
  sessionId: '99999999-9999-4999-8999-999999999999',
  viaEmailLink: false,
};

function build(
  required: boolean,
  row: { verifiedAt: Date | null } | null = null,
): { gate: LoginGateService; findUnique: jest.Mock } {
  const findUnique = jest.fn().mockResolvedValue(row);
  const gate = new LoginGateService(
    { loginVerification: { findUnique } } as unknown as PrismaService,
    { get: () => required } as unknown as ConfigService<Env, true>,
  );
  return { gate, findUnique };
}

describe('LoginGateService', () => {
  it('lets every sign-in through, without a query, when the kill switch is off', async () => {
    const { gate, findUnique } = build(false);
    await expect(gate.isVerified(SESSION)).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('trusts an email-link sign-in without a query', async () => {
    const { gate, findUnique } = build(true);
    await expect(gate.isVerified({ ...SESSION, viaEmailLink: true })).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('accepts a sign-in whose code was entered, and caches it', async () => {
    const { gate, findUnique } = build(true, { verifiedAt: new Date() });
    await expect(gate.isVerified(SESSION)).resolves.toBe(true);
    await expect(gate.isVerified(SESSION)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { sessionId: SESSION.sessionId },
      select: { verifiedAt: true },
    });
  });

  it('keys on the sign-in, not the token: a refreshed token of a verified sign-in is never asked again', async () => {
    const { gate, findUnique } = build(true);
    gate.remember(SESSION.sessionId);
    // A refreshed token carries the same session_id and nothing else the gate reads.
    await expect(gate.isVerified({ sessionId: SESSION.sessionId, viaEmailLink: false })).resolves.toBe(
      true,
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('refuses a sign-in with a row but no verifiedAt, and never caches the refusal', async () => {
    const { gate, findUnique } = build(true, { verifiedAt: null });
    await expect(gate.isVerified(SESSION)).resolves.toBe(false);
    await expect(gate.isVerified(SESSION)).resolves.toBe(false);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('refuses a sign-in with no row at all', async () => {
    const { gate } = build(true, null);
    await expect(gate.isVerified(SESSION)).resolves.toBe(false);
  });

  it('evicts the coldest sign-in past the cache size, and a hit refreshes recency', async () => {
    const { gate, findUnique } = build(true, null);
    const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

    gate.remember(id(0));
    gate.remember(id(1));
    for (let n = 2; n < VERIFIED_SESSION_CACHE_SIZE; n += 1) gate.remember(id(n));
    // id(0) is touched, so id(1) is now the coldest.
    await expect(gate.isVerified({ sessionId: id(0), viaEmailLink: false })).resolves.toBe(true);
    gate.remember(id(VERIFIED_SESSION_CACHE_SIZE));

    await expect(gate.isVerified({ sessionId: id(0), viaEmailLink: false })).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
    await expect(gate.isVerified({ sessionId: id(1), viaEmailLink: false })).resolves.toBe(false);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  describe('assertVerified', () => {
    it('throws 401 LOGIN_CODE_REQUIRED for an unverified sign-in', async () => {
      const { gate } = build(true, null);
      const caught = await gate.assertVerified(SESSION, false).then(
        () => null,
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(DomainException);
      expect((caught as DomainException).code).toBe('LOGIN_CODE_REQUIRED');
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('lets an exempt route through without a query', async () => {
      const { gate, findUnique } = build(true, null);
      await expect(gate.assertVerified(SESSION, true)).resolves.toBeUndefined();
      expect(findUnique).not.toHaveBeenCalled();
    });

    it('resolves for a verified sign-in', async () => {
      const { gate } = build(true, { verifiedAt: new Date() });
      await expect(gate.assertVerified(SESSION, false)).resolves.toBeUndefined();
    });
  });
});
```

Create `server/src/auth/login-code/login-code-setting.sync.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import type { EmailService } from '../../notifications/email.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { LoginGateService } from '../login-gate.service';
import { LoginCodeSettingSync } from './login-code-setting.sync';

function build(required: boolean, emailEnabled: boolean, upsert = jest.fn().mockResolvedValue({})) {
  const sync = new LoginCodeSettingSync(
    { loginCodeSetting: { upsert } } as unknown as PrismaService,
    { required } as unknown as LoginGateService,
    { enabled: emailEnabled } as unknown as EmailService,
  );
  return { sync, upsert };
}

describe('LoginCodeSettingSync', () => {
  let error: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    error.mockRestore();
  });

  it('writes the kill switch into the one setting row the Realtime policy reads', async () => {
    const { sync, upsert } = build(false, true);
    await sync.onModuleInit();
    expect(upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      create: { id: 1, required: false },
      update: { required: false },
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('logs an error, and still boots, when the gate is on but email is off', async () => {
    const { sync, upsert } = build(true, false);
    await sync.onModuleInit();
    expect(upsert).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/LOGIN_CODE_REQUIRED.*email/i));
  });

  it('logs and carries on when the database refuses the write — never a boot failure', async () => {
    const { sync } = build(true, true, jest.fn().mockRejectedValue(new Error('P1001')));
    await expect(sync.onModuleInit()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('P1001'));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test --workspace=server -- login-gate login-code-setting`
Expected: FAIL. The modules do not exist.

- [ ] **Step 3: Write the decorator, the gate and the sync**

Create `server/src/auth/decorators/allow-unverified-login.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';

export const ALLOW_UNVERIFIED_LOGIN_KEY = 'allowUnverifiedLogin';

/**
 * Lets a signed-in caller through BEFORE they have entered their emailed
 * sign-in code. Only the two /auth/login-code routes carry it: every other
 * authenticated route answers 401 LOGIN_CODE_REQUIRED to an unverified
 * sign-in. Not the same as @Public() — the token is still required and checked.
 */
export const AllowUnverifiedLogin = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_UNVERIFIED_LOGIN_KEY, true);
```

Create `server/src/auth/login-gate.service.ts`:

```ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthSession } from './auth.types';

/** Verified sign-ins remembered in memory, per instance. */
export const VERIFIED_SESSION_CACHE_SIZE = 10_000;

/**
 * THE ONE PLACE that decides whether a sign-in has passed the emailed code.
 *
 * Verified when the kill switch is off, when the sign-in came from an email
 * link (`amr`), or when its `LoginVerification` row has `verifiedAt`. Both
 * AuthGuard and StationTokenAccessGuard's staff path call `assertVerified`,
 * so the two can never disagree.
 *
 * Only POSITIVE answers are cached (a bounded LRU: a hit re-inserts, a full
 * cache drops the coldest). An unverified answer is re-read every time, so a
 * code entered on one request counts on the very next one. Verification is
 * permanent for a sign-in, so a cached "yes" never goes stale.
 */
@Injectable()
export class LoginGateService {
  readonly required: boolean;
  private readonly verified = new Map<string, true>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.required = config.get('LOGIN_CODE_REQUIRED', { infer: true });
  }

  async isVerified(session: AuthSession): Promise<boolean> {
    if (!this.required || session.viaEmailLink) return true;
    if (this.verified.has(session.sessionId)) {
      this.remember(session.sessionId);
      return true;
    }

    const row = await this.prisma.loginVerification.findUnique({
      where: { sessionId: session.sessionId },
      select: { verifiedAt: true },
    });
    if (row === null || row.verifiedAt === null) return false;

    this.remember(session.sessionId);
    return true;
  }

  /** Marks a sign-in verified in this instance's cache (and refreshes its recency). */
  remember(sessionId: string): void {
    this.verified.delete(sessionId);
    this.verified.set(sessionId, true);
    if (this.verified.size > VERIFIED_SESSION_CACHE_SIZE) {
      const coldest = this.verified.keys().next().value;
      if (coldest !== undefined) this.verified.delete(coldest);
    }
  }

  async assertVerified(session: AuthSession, exempt: boolean): Promise<void> {
    if (exempt) return;
    if (await this.isVerified(session)) return;
    throw new DomainException(
      'LOGIN_CODE_REQUIRED',
      'Enter the 6-digit code we emailed you to finish signing in.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}
```

Create `server/src/auth/login-code/login-code-setting.sync.ts`:

```ts
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EmailService } from '../../notifications/email.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginGateService } from '../login-gate.service';

/**
 * At boot: copy LOGIN_CODE_REQUIRED into `LoginCodeSetting` (the Realtime
 * policy cannot read env), and say loudly when the gate is on but email is off.
 *
 * Neither is fatal. A failed write leaves live chat on the LAST recorded
 * setting, or on "required" if the row is missing (the SQL fails closed); the
 * API's own gate follows the env regardless.
 */
@Injectable()
export class LoginCodeSettingSync implements OnModuleInit {
  private readonly logger = new Logger(LoginCodeSettingSync.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gate: LoginGateService,
    private readonly email: EmailService,
  ) {}

  async onModuleInit(): Promise<void> {
    const required = this.gate.required;

    if (required && !this.email.enabled) {
      this.logger.error(
        'LOGIN_CODE_REQUIRED is on but outbound email is disabled (RESEND_API_KEY / RESEND_FROM unset): ' +
          'nobody can finish signing in. Configure Resend, or set LOGIN_CODE_REQUIRED=false and restart.',
      );
    }

    try {
      await this.prisma.loginCodeSetting.upsert({
        where: { id: 1 },
        create: { id: 1, required },
        update: { required },
      });
    } catch (error) {
      this.logger.error(
        `Could not record LOGIN_CODE_REQUIRED=${String(required)} for live chat: ${(error as Error).message}. ` +
          'Live chat keeps the last recorded setting.',
      );
    }
  }
}
```

- [ ] **Step 4: Run the gate and sync tests to verify they pass**

Run: `npm test --workspace=server -- login-gate login-code-setting`
Expected: PASS.

- [ ] **Step 5: Write the failing guard tests**

In `server/src/auth/auth.guard.spec.ts`:
- Add imports: `HttpStatus` from `@nestjs/common`, `DomainException` from `'../common/exceptions/domain.exception'`, `IS_PUBLIC_KEY` from `'./decorators/public.decorator'`, `ALLOW_UNVERIFIED_LOGIN_KEY` from `'./decorators/allow-unverified-login.decorator'`, `LoginGateService` from `'./login-gate.service'`, and add `AuthSession` to the `auth.types` type import.
- Change `contextWith`'s request type to `{ headers: Record<string, string>; user?: AuthUser; authSession?: AuthSession }` (both places).
- Replace the `let`/`beforeEach` block with:

```ts
  let guard: AuthGuard;
  let verify: jest.Mock;
  let resolve: jest.Mock;
  let assertVerified: jest.Mock;
  let isPublic: boolean;
  let allowUnverified: boolean | undefined;

  beforeEach(() => {
    isPublic = false;
    allowUnverified = undefined;
    verify = jest.fn().mockResolvedValue(CLAIMS);
    resolve = jest.fn().mockResolvedValue(ACTIVE_USER);
    assertVerified = jest.fn().mockResolvedValue(undefined);

    const reflector = {
      getAllAndOverride: (key: string): boolean | undefined =>
        key === IS_PUBLIC_KEY ? isPublic : key === ALLOW_UNVERIFIED_LOGIN_KEY ? allowUnverified : undefined,
    } as unknown as Reflector;
    guard = new AuthGuard(
      reflector,
      { verify } as unknown as JwtVerifierService,
      { resolve } as unknown as UserProvisioningService,
      { assertVerified } as unknown as LoginGateService,
    );
  });
```

- Append these tests inside the describe:

```ts
  describe('the emailed sign-in code', () => {
    const SESSION: AuthSession = { sessionId: CLAIMS.sessionId, viaEmailLink: false };

    it('asks the gate about this sign-in, and attaches it as request.authSession', async () => {
      const { ctx, request } = contextWith({ authorization: 'Bearer good.token.here' });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(assertVerified).toHaveBeenCalledWith(SESSION, false);
      expect(request.authSession).toEqual(SESSION);
    });

    it('passes exempt=true on an @AllowUnverifiedLogin() route', async () => {
      allowUnverified = true;
      const { ctx } = contextWith({ authorization: 'Bearer good.token.here' });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(assertVerified).toHaveBeenCalledWith(SESSION, true);
    });

    it('marks a magic-link sign-in as an email link', async () => {
      verify.mockResolvedValue({ ...CLAIMS, amr: ['otp'] });
      const { ctx } = contextWith({ authorization: 'Bearer good.token.here' });
      await guard.canActivate(ctx);
      expect(assertVerified).toHaveBeenCalledWith({ ...SESSION, viaEmailLink: true }, false);
    });

    it('lets the 401 LOGIN_CODE_REQUIRED through untouched, and attaches no user', async () => {
      assertVerified.mockRejectedValue(
        new DomainException('LOGIN_CODE_REQUIRED', 'Enter the code', HttpStatus.UNAUTHORIZED),
      );
      const { ctx, request } = contextWith({ authorization: 'Bearer good.token.here' });
      const caught = await guard.canActivate(ctx).then(
        () => null,
        (error: unknown) => error,
      );
      expect((caught as DomainException).code).toBe('LOGIN_CODE_REQUIRED');
      expect(request.user).toBeUndefined();
    });

    it('answers a deactivated account 403 before asking for a code', async () => {
      resolve.mockResolvedValue({ ...ACTIVE_USER, status: 'DEACTIVATED' });
      const { ctx } = contextWith({ authorization: 'Bearer good.token.here' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
      expect(assertVerified).not.toHaveBeenCalled();
    });

    it('never consults the gate on a @Public() route', async () => {
      isPublic = true;
      const { ctx } = contextWith({});
      await guard.canActivate(ctx);
      expect(assertVerified).not.toHaveBeenCalled();
    });
  });
```

Create `server/src/checkin/station.guard.spec.ts`:

```ts
import { ExecutionContext, ForbiddenException, HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';
import type { PrismaService } from '../prisma/prisma.service';
import type { JwtVerifierService } from '../auth/jwt-verifier.service';
import type { UserProvisioningService } from '../auth/user-provisioning.service';
import type { PermissionsService } from '../rbac/permissions.service';
import type { LoginGateService } from '../auth/login-gate.service';
import type { AuthUser, SupabaseClaims } from '../auth/auth.types';
import {
  STATION_TOKEN_ISSUE_PERMISSION,
  StationTokenAccessGuard,
  type RequestWithStationAccess,
} from './station.guard';

const CLAIMS: SupabaseClaims = {
  sub: '11111111-1111-1111-1111-111111111111',
  email: 'desk@example.com',
  firstName: 'Desk',
  lastName: 'Staff',
  phone: null,
  heightCm: null,
  weightKg: null,
  dateOfBirth: null,
  sessionId: '99999999-9999-4999-8999-999999999999',
  amr: ['password'],
};

const STAFF: AuthUser = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  supabaseId: CLAIMS.sub,
  email: CLAIMS.email,
  firstName: 'Desk',
  lastName: 'Staff',
  role: 'FRONT_DESK',
  status: 'ACTIVE',
  permissionVersion: 0,
  heightCm: null,
  weightKg: null,
  deletedAt: null,
};

/**
 * The staff-preview path verifies JWTs BY HAND, outside AuthGuard, so it must
 * run the same emailed-code gate — or a stolen password would open the
 * station display's token feed. The credential path has no user at all and
 * never asks.
 */
describe('StationTokenAccessGuard — emailed sign-in code', () => {
  let assertVerified: jest.Mock;
  let getEffectivePermissions: jest.Mock;
  let guard: StationTokenAccessGuard;

  const contextWith = (
    headers: Record<string, string>,
  ): { ctx: ExecutionContext; request: RequestWithStationAccess } => {
    const request = { headers, ip: '203.0.113.9' } as unknown as RequestWithStationAccess;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { ctx, request };
  };

  beforeEach(() => {
    assertVerified = jest.fn().mockResolvedValue(undefined);
    getEffectivePermissions = jest
      .fn()
      .mockResolvedValue([{ key: STATION_TOKEN_ISSUE_PERMISSION, scope: 'ALL' }]);
    const prisma = {
      stationCredential: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cred-1',
          revokedAt: null,
          station: { id: 'st-1', code: 'FRONT', name: 'Front door', tokenEpoch: 0, isActive: true },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    guard = new StationTokenAccessGuard(
      prisma as unknown as PrismaService,
      { get: () => 'p'.repeat(32) } as unknown as ConfigService<Env, true>,
      { verify: jest.fn().mockResolvedValue(CLAIMS) } as unknown as JwtVerifierService,
      { resolve: jest.fn().mockResolvedValue(STAFF) } as unknown as UserProvisioningService,
      { getEffectivePermissions } as unknown as PermissionsService,
      { assertVerified } as unknown as LoginGateService,
    );
  });

  it('lets a verified staff sign-in through, and attaches user and sign-in', async () => {
    const { ctx, request } = contextWith({ authorization: 'Bearer t' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(assertVerified).toHaveBeenCalledWith(
      { sessionId: CLAIMS.sessionId, viaEmailLink: false },
      false,
    );
    expect(request.user).toEqual(STAFF);
    expect(request.authSession).toEqual({ sessionId: CLAIMS.sessionId, viaEmailLink: false });
  });

  it('refuses an unverified staff sign-in with LOGIN_CODE_REQUIRED, before the permission check', async () => {
    assertVerified.mockRejectedValue(
      new DomainException('LOGIN_CODE_REQUIRED', 'Enter the code', HttpStatus.UNAUTHORIZED),
    );
    const { ctx, request } = contextWith({ authorization: 'Bearer t' });
    const caught = await guard.canActivate(ctx).then(
      () => null,
      (error: unknown) => error,
    );
    expect((caught as DomainException).code).toBe('LOGIN_CODE_REQUIRED');
    expect(getEffectivePermissions).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it('still refuses a verified sign-in without the permission', async () => {
    getEffectivePermissions.mockResolvedValue([]);
    const { ctx } = contextWith({ authorization: 'Bearer t' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('never asks for a code on the X-Station-Key credential path', async () => {
    const { ctx, request } = contextWith({ 'x-station-key': 'k'.repeat(40) });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(assertVerified).not.toHaveBeenCalled();
    expect(request.station?.id).toBe('st-1');
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npm test --workspace=server -- auth.guard station.guard`
Expected: FAIL. `assertVerified` is never called, and the guards' constructors do not take a gate.

- [ ] **Step 7: Wire the gate into both guards and the module**

Replace `server/src/auth/auth.guard.ts`'s imports and `canActivate` as follows (the doc comment and `extractBearerToken` stay):

```ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { ALLOW_UNVERIFIED_LOGIN_KEY } from './decorators/allow-unverified-login.decorator';
import { JwtVerifierService } from './jwt-verifier.service';
import { UserProvisioningService } from './user-provisioning.service';
import { LoginGateService } from './login-gate.service';
import { authSessionFrom } from './auth-session';
import type { AuthSession, AuthUser } from './auth.types';
```

```ts
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtVerifierService,
    private readonly provisioning: UserProvisioningService,
    private readonly gate: LoginGateService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser; authSession?: AuthSession }>();
    const token = this.extractBearerToken(request.headers.authorization);

    let user: AuthUser;
    let session: AuthSession;
    try {
      const claims = await this.jwt.verify(token);
      user = await this.provisioning.resolve(claims);
      session = authSessionFrom(claims);
    } catch (error) {
      // Log the real reason server-side; tell the client only that auth
      // failed. Echoing the verification error back would tell an attacker
      // exactly which check they tripped.
      this.logger.warn(`Token rejected: ${(error as Error).message}`);
      throw new UnauthorizedException('Invalid or expired token');
    }

    // (keep the existing SUSPENDED / DEACTIVATED comment block and 403 here unchanged)
    if (user.status === 'DEACTIVATED' || user.deletedAt) {
      throw new ForbiddenException('Account is not active');
    }

    // The emailed sign-in code. AFTER the status check, so a closed account
    // hears 403 rather than being asked for a code it cannot use. Only the two
    // /auth/login-code routes are exempt.
    const exempt =
      this.reflector.getAllAndOverride<boolean>(ALLOW_UNVERIFIED_LOGIN_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    await this.gate.assertVerified(session, exempt);

    request.user = user;
    request.authSession = session;
    return true;
  }
```

(When editing, keep the two existing comment blocks inside the status check exactly as they are. The placeholder comment above only marks where they stay.)

In `server/src/checkin/station.guard.ts`:
- Add imports: `import { LoginGateService } from '../auth/login-gate.service';`, `import { authSessionFrom } from '../auth/auth-session';`, and change the type import to `import type { AuthSession, AuthUser } from '../auth/auth.types';`.
- Extend `RequestWithStationAccess` with `authSession?: AuthSession;`.
- Add a sixth constructor parameter: `private readonly gate: LoginGateService,`.
- Replace `authenticateStaff`'s body from `let user: AuthUser;` down to `request.user = user;` with:

```ts
    let user: AuthUser;
    let session: AuthSession;
    try {
      const claims = await this.jwt.verify(token);
      user = await this.provisioning.resolve(claims);
      session = authSessionFrom(claims);
    } catch {
      // Same doctrine as AuthGuard: the real reason never reaches the client.
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (user.status !== 'ACTIVE' || user.deletedAt) {
      throw new ForbiddenException('Account is not active');
    }

    // The emailed sign-in code — the SAME decision AuthGuard makes, from the
    // same service. This route is @Public() for AuthGuard, so without this a
    // password alone would open the station display's token feed.
    await this.gate.assertVerified(session, false);

    const held = await this.permissions.getEffectivePermissions(user);
    if (!held.some((permission) => permission.key === STATION_TOKEN_ISSUE_PERMISSION)) {
      throw new ForbiddenException(
        `Missing required permission: ${STATION_TOKEN_ISSUE_PERMISSION}`,
      );
    }

    request.user = user;
    request.authSession = session;
```

In `server/src/auth/auth.module.ts`, import `LoginGateService` and `LoginCodeSettingSync`, and set:

```ts
  providers: [
    JwtVerifierService,
    UserProvisioningService,
    AuthGuard,
    SupabaseAdminService,
    LoginGateService,
    LoginCodeSettingSync,
  ],
  exports: [JwtVerifierService, UserProvisioningService, AuthGuard, SupabaseAdminService, LoginGateService],
```

- [ ] **Step 8: Run the guard tests and the whole auth/checkin suites**

Run: `npm test --workspace=server -- auth.guard station.guard login-gate login-code-setting app.module`
Expected: PASS.

Run: `npm test --workspace=server -- src/auth src/checkin`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/auth server/src/checkin/station.guard.ts server/src/checkin/station.guard.spec.ts
git commit -m "feat(login-code): one gate for AuthGuard and the station staff path

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The code itself, and its email

**Files:**
- Create: `server/src/auth/login-code/login-code.constants.ts`
- Create: `server/src/auth/login-code/login-code.crypto.ts`
- Test: `server/src/auth/login-code/login-code.crypto.spec.ts`
- Modify: `server/src/notifications/email.service.ts` (new method after `sendStaffInvite`; new template after `staffInviteHtml`)
- Test: `server/src/notifications/email.service.spec.ts`

**Interfaces:**
- Produces: `LOGIN_CODE_TTL_MS = 600_000`, `LOGIN_CODE_MAX_ATTEMPTS = 5`, `LOGIN_CODE_RESEND_COOLDOWN_MS = 60_000`, `LOGIN_CODE_MAX_SENDS_PER_SIGN_IN = 5`, `LOGIN_CODE_MAX_SENDS_PER_HOUR = 10`, `LOGIN_CODE_HOUR_MS = 3_600_000`.
- Produces: `generateLoginCode(draw?: (min: number, max: number) => number): string`, `hashLoginCode(pepper: string, sessionId: string, code: string): string` (64 lower-case hex), `loginCodeMatches(presentedHash: string, storedHash: string): boolean`.
- Produces: `EmailService.sendLoginCode(to: string, input: { name: string; code: string }): Promise<void>`. It throws when disabled or when Resend refuses.

- [ ] **Step 1: Write the failing tests**

Create `server/src/auth/login-code/login-code.crypto.spec.ts`:

```ts
import { createHmac } from 'node:crypto';
import { generateLoginCode, hashLoginCode, loginCodeMatches } from './login-code.crypto';

const PEPPER = 'z'.repeat(32);
const SESSION_A = '99999999-9999-4999-8999-999999999999';
const SESSION_B = '88888888-8888-4888-8888-888888888888';

describe('generateLoginCode', () => {
  it('draws from 0..999999 and zero-pads to six digits', () => {
    const draw = jest.fn().mockReturnValue(42);
    expect(generateLoginCode(draw)).toBe('000042');
    expect(draw).toHaveBeenCalledWith(0, 1_000_000);
  });

  it('keeps the top of the range as six digits', () => {
    expect(generateLoginCode(() => 999_999)).toBe('999999');
  });

  it('produces six digits from the real generator', () => {
    for (let i = 0; i < 50; i += 1) expect(generateLoginCode()).toMatch(/^\d{6}$/);
  });
});

describe('hashLoginCode', () => {
  it('is HMAC-SHA256 keyed by the pepper over the domain-separated string', () => {
    const expected = createHmac('sha256', PEPPER)
      .update(`login-code:v1:${SESSION_A}:123456`)
      .digest('hex');
    expect(hashLoginCode(PEPPER, SESSION_A, '123456')).toBe(expected);
  });

  it('is 64 lower-case hex characters — what LoginVerification_code_hash_shape demands', () => {
    expect(hashLoginCode(PEPPER, SESSION_A, '000000')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds the code to its sign-in: the same code hashes differently for another session', () => {
    expect(hashLoginCode(PEPPER, SESSION_A, '123456')).not.toBe(
      hashLoginCode(PEPPER, SESSION_B, '123456'),
    );
  });

  it('is useless without the server secret: another pepper gives another hash', () => {
    expect(hashLoginCode(PEPPER, SESSION_A, '123456')).not.toBe(
      hashLoginCode('y'.repeat(32), SESSION_A, '123456'),
    );
  });
});

describe('loginCodeMatches', () => {
  const stored = hashLoginCode(PEPPER, SESSION_A, '123456');

  it('matches the same hash', () => {
    expect(loginCodeMatches(hashLoginCode(PEPPER, SESSION_A, '123456'), stored)).toBe(true);
  });

  it('does not match another code', () => {
    expect(loginCodeMatches(hashLoginCode(PEPPER, SESSION_A, '123457'), stored)).toBe(false);
  });

  it('returns false, never throws, for a malformed hash', () => {
    expect(loginCodeMatches('abc', stored)).toBe(false);
    expect(loginCodeMatches(stored, '')).toBe(false);
  });
});
```

In `server/src/notifications/email.service.spec.ts`, append inside the top-level describe:

```ts
  // ── Sign-in code ────────────────────────────────────────────────────────
  describe('sendLoginCode', () => {
    it('puts the code in the subject and large in the body, with the expiry line', async () => {
      send.mockResolvedValue({ data: { id: 'email_4' }, error: null });
      const service = new EmailService(buildConfig());

      await service.sendLoginCode('ana@example.com', { name: 'Ana', code: '012345' });

      const sent = send.mock.calls[0][0];
      expect(sent.to).toBe('ana@example.com');
      expect(sent.subject).toBe('Your Gym of Thrones sign-in code: 012345');
      expect(sent.html).toContain('012345');
      expect(sent.html).toContain(
        "It expires in 10 minutes. If you didn't try to sign in, change your password.",
      );
    });

    it('escapes the name', async () => {
      send.mockResolvedValue({ data: { id: 'email_4' }, error: null });
      const service = new EmailService(buildConfig());

      await service.sendLoginCode('ana@example.com', { name: '<b>Ana</b>', code: '123456' });
      const html = send.mock.calls[0][0].html as string;
      expect(html).not.toContain('<b>Ana</b>');
      expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
    });

    it('throws, and never calls Resend, when disabled', async () => {
      const disabled = new EmailService(buildConfig({ RESEND_FROM: undefined }));
      await expect(
        disabled.sendLoginCode('ana@example.com', { name: 'Ana', code: '123456' }),
      ).rejects.toThrow(/disabled/);
      expect(send).not.toHaveBeenCalled();
    });

    it('throws when Resend reports an error', async () => {
      send.mockResolvedValue({ data: null, error: { message: 'daily quota exceeded' } });
      const service = new EmailService(buildConfig());
      await expect(
        service.sendLoginCode('ana@example.com', { name: 'Ana', code: '123456' }),
      ).rejects.toThrow(/daily quota exceeded/);
    });
  });
```

The `{ name, code }` copy above contains an apostrophe. The `escapeHtml` in `email.service.ts` turns `'` into `&#39;`, so the expiry sentence must be written as literal HTML, not passed through `escapeHtml`. Step 3 does that.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test --workspace=server -- login-code.crypto email.service`
Expected: FAIL. The module is missing, and `sendLoginCode` is not a function.

- [ ] **Step 3: Implement**

Create `server/src/auth/login-code/login-code.constants.ts`:

```ts
/**
 * The emailed sign-in code's rules (spec "Code rules"). The CHECKs in
 * migration 20261015000000_login_verification hard-code 5 for both
 * MAX_ATTEMPTS and MAX_SENDS_PER_SIGN_IN — change them together.
 */
export const LOGIN_CODE_TTL_MS = 10 * 60_000;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
export const LOGIN_CODE_RESEND_COOLDOWN_MS = 60_000;
export const LOGIN_CODE_MAX_SENDS_PER_SIGN_IN = 5;
export const LOGIN_CODE_MAX_SENDS_PER_HOUR = 10;
export const LOGIN_CODE_HOUR_MS = 60 * 60_000;
```

Create `server/src/auth/login-code/login-code.crypto.ts`:

```ts
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** Six digits, uniformly from 000000..999999. `draw` is a seam for tests only. */
export function generateLoginCode(
  draw: (min: number, max: number) => number = (min, max) => randomInt(min, max),
): string {
  return draw(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * HMAC-SHA256, keyed by IP_HASH_PEPPER, over `login-code:v1:<sessionId>:<code>`.
 *
 * Keyed, because a million six-digit codes are trivially brute-forced from a
 * plain hash, and a leaked table without the server secret is useless.
 * Domain-separated (`login-code:v1`) so this pepper's other use (hashing IPs)
 * can never produce a colliding value, and bound to the sign-in so a code is
 * worthless on any other session.
 */
export function hashLoginCode(pepper: string, sessionId: string, code: string): string {
  return createHmac('sha256', pepper).update(`login-code:v1:${sessionId}:${code}`).digest('hex');
}

/** Constant-time comparison of two hex HMACs. False, never a throw, on a malformed input. */
export function loginCodeMatches(presentedHash: string, storedHash: string): boolean {
  const presented = Buffer.from(presentedHash, 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === 32 && stored.length === 32 && timingSafeEqual(presented, stored);
}
```

In `server/src/notifications/email.service.ts`, add after `sendStaffInvite`:

```ts
  /**
   * The emailed sign-in code: the second step after the password, on every
   * sign-in. Throws like the others; `LoginCodeService.send` catches, un-counts
   * the send and answers 503 LOGIN_CODE_EMAIL_FAILED.
   */
  async sendLoginCode(to: string, input: { name: string; code: string }): Promise<void> {
    if (this.client === null || this.from === null) {
      throw new Error('EmailService is disabled: RESEND_API_KEY / RESEND_FROM not configured.');
    }

    const { error } = await this.client.emails.send({
      from: this.from,
      to,
      subject: `Your Gym of Thrones sign-in code: ${input.code}`,
      html: loginCodeHtml(input),
    });

    if (error) {
      throw new Error(`Resend send failed: ${error.message}`);
    }
  }
```

Add after `staffInviteHtml`:

```ts
function loginCodeHtml(input: { name: string; code: string }): string {
  return (
    `<p>Hi ${escapeHtml(input.name)}, here is your Gym of Thrones sign-in code:</p>` +
    `<p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:16px 0">${escapeHtml(input.code)}</p>` +
    `<p>It expires in 10 minutes. If you didn't try to sign in, change your password.</p>`
  );
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test --workspace=server -- login-code.crypto email.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/login-code/login-code.constants.ts server/src/auth/login-code/login-code.crypto.ts server/src/auth/login-code/login-code.crypto.spec.ts server/src/notifications/email.service.ts server/src/notifications/email.service.spec.ts
git commit -m "feat(login-code): code generation, keyed hash, and the sign-in code email

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `LoginCodeService` — issue, verify, caps

**Files:**
- Create: `server/src/auth/login-code/login-code.service.ts`
- Test: `server/src/auth/login-code/login-code.service.spec.ts`

**Interfaces:**
- Consumes: `LoginGateService.isVerified(session)` and `.remember(sessionId)` (Task 4); constants and crypto, and `EmailService.sendLoginCode` (Task 5); `maskEmail(email: string): string` from `server/src/staff-invitations/invitation-token.ts`; `LoginCodeSendResult`, `LoginCodeVerified` (Task 1).
- Produces: `LoginCodeService.send(user: AuthUser, session: AuthSession): Promise<LoginCodeSendResult>` and `LoginCodeService.verify(user: AuthUser, session: AuthSession, code: string): Promise<LoginCodeVerified>`.

**Ruling recorded in code (hourly cap):** the per-account hour counts `SUM(sendCount)` over this user's rows whose `lastSentAt` falls within the last hour. A row's every send happened at or before its `lastSentAt`, so this never undercounts. It can overcount (an older send on a recently-resent row), which only refuses early. That needs no new table, and the ceiling exists to protect the Resend quota.

- [ ] **Step 1: Write the failing tests**

Create `server/src/auth/login-code/login-code.service.spec.ts`:

```ts
import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DomainException } from '../../common/exceptions/domain.exception';
import type { Env } from '../../config/env.validation';
import type { EmailService } from '../../notifications/email.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthSession, AuthUser } from '../auth.types';
import type { LoginGateService } from '../login-gate.service';
import { hashLoginCode } from './login-code.crypto';
import { LoginCodeService } from './login-code.service';

const PEPPER = 'z'.repeat(32);
const NOW = new Date('2026-10-15T02:00:00.000Z');
const SESSION: AuthSession = {
  sessionId: '99999999-9999-4999-8999-999999999999',
  viaEmailLink: false,
};
const USER = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  email: 'juana.cruz@gmail.com',
  firstName: 'Juana',
} as AuthUser;

interface Row {
  sessionId: string;
  userId: string;
  codeHash: string | null;
  codeExpiresAt: Date | null;
  attempts: number;
  sendCount: number;
  lastSentAt: Date | null;
  verifiedAt: Date | null;
  createdAt: Date;
}

const at = (msFromNow: number): Date => new Date(NOW.getTime() + msFromNow);
const hashOf = (code: string, sessionId = SESSION.sessionId): string =>
  hashLoginCode(PEPPER, sessionId, code);

/** A row with a live code '123456' sent `sentAgoMs` ago. */
const liveRow = (over: Partial<Row> = {}, sentAgoMs = 120_000): Row => ({
  sessionId: SESSION.sessionId,
  userId: USER.id,
  codeHash: hashOf('123456'),
  codeExpiresAt: at(-sentAgoMs + 600_000),
  attempts: 0,
  sendCount: 1,
  lastSentAt: at(-sentAgoMs),
  verifiedAt: null,
  createdAt: at(-sentAgoMs),
  ...over,
});

/** Enough of Prisma's `where` semantics for the guards this service writes. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key as keyof Row];
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (cond !== null && typeof cond === 'object' && 'lt' in cond) {
      return (value as number) < (cond as { lt: number }).lt;
    }
    return value === cond;
  });
}

function apply(row: Row, data: Record<string, unknown>): Row {
  const next: Record<string, unknown> = { ...row };
  for (const [key, change] of Object.entries(data)) {
    if (change !== null && typeof change === 'object' && !(change instanceof Date)) {
      const delta = change as { increment?: number; decrement?: number };
      next[key] = (next[key] as number) + (delta.increment ?? 0) - (delta.decrement ?? 0);
    } else {
      next[key] = change;
    }
  }
  return next as unknown as Row;
}

async function domainError(promise: Promise<unknown>): Promise<DomainException> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(DomainException);
  return caught as DomainException;
}

describe('LoginCodeService', () => {
  let row: Row | null;
  let hourSends: number;
  let prisma: {
    loginVerification: {
      createMany: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      aggregate: jest.Mock;
    };
  };
  let gate: { isVerified: jest.Mock; remember: jest.Mock };
  let email: { enabled: boolean; sendLoginCode: jest.Mock };
  let service: LoginCodeService;

  const sentCode = (call = 0): string =>
    (email.sendLoginCode.mock.calls[call] as [string, { code: string }])[1].code;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    row = null;
    hourSends = 0;
    prisma = {
      loginVerification: {
        createMany: jest.fn(({ data }: { data: Array<Partial<Row>> }) => {
          if (row !== null) return Promise.resolve({ count: 0 });
          row = {
            codeHash: null,
            codeExpiresAt: null,
            attempts: 0,
            sendCount: 0,
            lastSentAt: null,
            verifiedAt: null,
            ...(data[0] as Pick<Row, 'sessionId' | 'userId' | 'createdAt'>),
          };
          return Promise.resolve({ count: 1 });
        }),
        findUnique: jest.fn(() => Promise.resolve(row === null ? null : { ...row })),
        updateMany: jest.fn(
          ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            if (row === null || !matches(row, where)) return Promise.resolve({ count: 0 });
            row = apply(row, data);
            return Promise.resolve({ count: 1 });
          },
        ),
        aggregate: jest.fn(() => Promise.resolve({ _sum: { sendCount: hourSends } })),
      },
    };
    gate = { isVerified: jest.fn().mockResolvedValue(false), remember: jest.fn() };
    email = { enabled: true, sendLoginCode: jest.fn().mockResolvedValue(undefined) };
    service = new LoginCodeService(
      prisma as unknown as PrismaService,
      { get: () => PEPPER } as unknown as ConfigService<Env, true>,
      email as unknown as EmailService,
      gate as unknown as LoginGateService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('send', () => {
    it('sends nothing to a sign-in that is already verified', async () => {
      gate.isVerified.mockResolvedValue(true);
      await expect(service.send(USER, SESSION)).resolves.toEqual({ verified: true });
      expect(email.sendLoginCode).not.toHaveBeenCalled();
      expect(prisma.loginVerification.createMany).not.toHaveBeenCalled();
    });

    it('creates the row from the app clock, emails a 6-digit code, and stores only its HMAC', async () => {
      await expect(service.send(USER, SESSION)).resolves.toEqual({
        verified: false,
        sentTo: 'ju***@gmail.com',
        resendAvailableAt: at(60_000).toISOString(),
        expiresAt: at(600_000).toISOString(),
      });
      expect(prisma.loginVerification.createMany).toHaveBeenCalledWith({
        data: [{ sessionId: SESSION.sessionId, userId: USER.id, createdAt: NOW }],
        skipDuplicates: true,
      });
      expect(email.sendLoginCode).toHaveBeenCalledWith('juana.cruz@gmail.com', {
        name: 'Juana',
        code: expect.stringMatching(/^\d{6}$/) as unknown as string,
      });
      expect(row?.codeHash).toBe(hashOf(sentCode()));
      expect(row?.sendCount).toBe(1);
    });

    it('within 60 seconds returns the code already on its way, and sends nothing', async () => {
      row = liveRow({}, 30_000);
      await expect(service.send(USER, SESSION)).resolves.toEqual({
        verified: false,
        sentTo: 'ju***@gmail.com',
        resendAvailableAt: at(30_000).toISOString(),
        expiresAt: at(570_000).toISOString(),
      });
      expect(email.sendLoginCode).not.toHaveBeenCalled();
    });

    it('after 60 seconds replaces the code and resets the attempts', async () => {
      row = liveRow({ attempts: 3 }, 60_000);
      await service.send(USER, SESSION);
      expect(row?.codeHash).toBe(hashOf(sentCode()));
      expect(row?.attempts).toBe(0);
      expect(row?.sendCount).toBe(2);
      expect(row?.lastSentAt).toEqual(NOW);
    });

    it('stops at five codes for one sign-in with 429 LOGIN_CODE_SEND_LIMIT', async () => {
      row = liveRow({ sendCount: 5 }, 120_000);
      const error = await domainError(service.send(USER, SESSION));
      expect(error.code).toBe('LOGIN_CODE_SEND_LIMIT');
      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(email.sendLoginCode).not.toHaveBeenCalled();
    });

    it('stops at ten codes per account per rolling hour', async () => {
      hourSends = 10;
      const error = await domainError(service.send(USER, SESSION));
      expect(error.code).toBe('LOGIN_CODE_SEND_LIMIT');
      expect(prisma.loginVerification.aggregate).toHaveBeenCalledWith({
        where: { userId: USER.id, lastSentAt: { gt: at(-3_600_000) } },
        _sum: { sendCount: true },
      });
    });

    it('answers 503 LOGIN_CODE_EMAIL_FAILED when email is not configured, and counts nothing', async () => {
      email.enabled = false;
      const error = await domainError(service.send(USER, SESSION));
      expect(error.code).toBe('LOGIN_CODE_EMAIL_FAILED');
      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(row?.sendCount).toBe(0);
      expect(row?.codeHash).toBeNull();
    });

    it('un-counts a send Resend refused, and the previous code keeps working', async () => {
      row = liveRow({ attempts: 2 }, 120_000);
      const before = { ...row };
      email.sendLoginCode.mockRejectedValue(new Error('Resend send failed: quota'));
      const error = await domainError(service.send(USER, SESSION));
      expect(error.code).toBe('LOGIN_CODE_EMAIL_FAILED');
      expect(row).toEqual(before);
    });

    it('a second tab losing the send race gets the winner’s state, not a second email', async () => {
      row = liveRow({}, 120_000);
      prisma.loginVerification.updateMany.mockImplementationOnce(() => {
        row = { ...(row as Row), sendCount: 2, lastSentAt: NOW, codeHash: hashOf('654321'), codeExpiresAt: at(600_000) };
        return Promise.resolve({ count: 0 });
      });
      await expect(service.send(USER, SESSION)).resolves.toMatchObject({
        verified: false,
        resendAvailableAt: at(60_000).toISOString(),
      });
      expect(email.sendLoginCode).not.toHaveBeenCalled();
    });

    it('reports a row verified meanwhile as verified, and warms the cache', async () => {
      row = liveRow({ codeHash: null, codeExpiresAt: null, verifiedAt: at(-1_000) });
      await expect(service.send(USER, SESSION)).resolves.toEqual({ verified: true });
      expect(gate.remember).toHaveBeenCalledWith(SESSION.sessionId);
    });

    it('refuses a sign-in row that belongs to another account', async () => {
      row = liveRow({ userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
      await expect(service.send(USER, SESSION)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('verify', () => {
    it('accepts the right code: sets verifiedAt, clears the hash, warms the cache', async () => {
      row = liveRow();
      await expect(service.verify(USER, SESSION, '123456')).resolves.toEqual({ verified: true });
      expect(row?.verifiedAt).toEqual(NOW);
      expect(row?.codeHash).toBeNull();
      expect(row?.codeExpiresAt).toBeNull();
      expect(gate.remember).toHaveBeenCalledWith(SESSION.sessionId);
    });

    it('never writes verifiedAt before createdAt, even when the clock stepped back', async () => {
      row = liveRow({ createdAt: at(2_000) });
      await service.verify(USER, SESSION, '123456');
      expect(row?.verifiedAt).toEqual(at(2_000));
    });

    it('answers a wrong code 422 LOGIN_CODE_INVALID with attempts left', async () => {
      row = liveRow();
      const error = await domainError(service.verify(USER, SESSION, '000000'));
      expect(error.code).toBe('LOGIN_CODE_INVALID');
      expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(error.details).toEqual({ attemptsLeft: 4 });
      expect(row?.attempts).toBe(1);
    });

    it('answers the fifth wrong guess LOGIN_CODE_LOCKED', async () => {
      row = liveRow({ attempts: 4 });
      const error = await domainError(service.verify(USER, SESSION, '000000'));
      expect(error.code).toBe('LOGIN_CODE_LOCKED');
      expect(row?.attempts).toBe(5);
    });

    it('keeps a burned code burned, even for the right digits', async () => {
      row = liveRow({ attempts: 5 });
      expect((await domainError(service.verify(USER, SESSION, '123456'))).code).toBe(
        'LOGIN_CODE_LOCKED',
      );
    });

    it('expires a code AT its expiry instant, and accepts it a millisecond before', async () => {
      row = liveRow({ codeExpiresAt: NOW });
      expect((await domainError(service.verify(USER, SESSION, '123456'))).code).toBe(
        'LOGIN_CODE_EXPIRED',
      );
      row = liveRow({ codeExpiresAt: at(1) });
      await expect(service.verify(USER, SESSION, '123456')).resolves.toEqual({ verified: true });
    });

    it('answers EXPIRED when no code was ever sent', async () => {
      expect((await domainError(service.verify(USER, SESSION, '123456'))).code).toBe(
        'LOGIN_CODE_EXPIRED',
      );
    });

    it('is a no-op for a sign-in already verified (a second tab)', async () => {
      gate.isVerified.mockResolvedValue(true);
      await expect(service.verify(USER, SESSION, '999999')).resolves.toEqual({ verified: true });
      expect(prisma.loginVerification.findUnique).not.toHaveBeenCalled();
    });

    it('two tabs with the right code: the loser still hears verified', async () => {
      row = liveRow();
      prisma.loginVerification.updateMany.mockImplementationOnce(() => {
        row = { ...(row as Row), verifiedAt: NOW, codeHash: null, codeExpiresAt: null };
        return Promise.resolve({ count: 0 });
      });
      await expect(service.verify(USER, SESSION, '123456')).resolves.toEqual({ verified: true });
    });

    it('a right code that a resend replaced mid-request is EXPIRED, not verified', async () => {
      row = liveRow();
      prisma.loginVerification.updateMany.mockImplementationOnce(() => {
        row = { ...(row as Row), codeHash: hashOf('654321'), sendCount: 2 };
        return Promise.resolve({ count: 0 });
      });
      expect((await domainError(service.verify(USER, SESSION, '123456'))).code).toBe(
        'LOGIN_CODE_EXPIRED',
      );
      expect(gate.remember).not.toHaveBeenCalled();
    });

    it('a wrong guess against a replaced code never counts against the new code', async () => {
      row = liveRow();
      prisma.loginVerification.updateMany.mockImplementationOnce(() => {
        row = { ...(row as Row), codeHash: hashOf('654321'), attempts: 0, sendCount: 2 };
        return Promise.resolve({ count: 0 });
      });
      const error = await domainError(service.verify(USER, SESSION, '000000'));
      expect(error.code).toBe('LOGIN_CODE_INVALID');
      expect(error.details).toEqual({ attemptsLeft: 5 });
      expect(row?.attempts).toBe(0);
    });

    it('only the latest code works after a resend', async () => {
      row = liveRow({}, 120_000);
      await service.send(USER, SESSION);
      expect((await domainError(service.verify(USER, SESSION, '123456'))).code).toBe(
        'LOGIN_CODE_INVALID',
      );
      await expect(service.verify(USER, SESSION, sentCode())).resolves.toEqual({ verified: true });
    });

    it('a code is bound to its sign-in: the same digits hashed for another session fail', async () => {
      row = liveRow({ codeHash: hashOf('123456', '88888888-8888-4888-8888-888888888888') });
      expect((await domainError(service.verify(USER, SESSION, '123456'))).code).toBe(
        'LOGIN_CODE_INVALID',
      );
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test --workspace=server -- login-code.service`
Expected: FAIL. `./login-code.service` cannot be found.

- [ ] **Step 3: Implement the service**

Create `server/src/auth/login-code/login-code.service.ts`:

```ts
import { HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LoginCodeSendResult, LoginCodeVerified } from '@got/shared';
import { DomainException } from '../../common/exceptions/domain.exception';
import type { Env } from '../../config/env.validation';
import { EmailService } from '../../notifications/email.service';
import { PrismaService } from '../../prisma/prisma.service';
import { maskEmail } from '../../staff-invitations/invitation-token';
import type { AuthSession, AuthUser } from '../auth.types';
import { LoginGateService } from '../login-gate.service';
import {
  LOGIN_CODE_HOUR_MS,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_MAX_SENDS_PER_HOUR,
  LOGIN_CODE_MAX_SENDS_PER_SIGN_IN,
  LOGIN_CODE_RESEND_COOLDOWN_MS,
  LOGIN_CODE_TTL_MS,
} from './login-code.constants';
import { generateLoginCode, hashLoginCode, loginCodeMatches } from './login-code.crypto';

interface CodeRow {
  sessionId: string;
  userId: string;
  codeHash: string | null;
  codeExpiresAt: Date | null;
  attempts: number;
  sendCount: number;
  lastSentAt: Date | null;
  verifiedAt: Date | null;
  createdAt: Date;
}

/**
 * Issues and checks the emailed sign-in code for ONE Supabase sign-in.
 *
 * CONCURRENCY. Two tabs, a double tap, or a resend racing a verify all hit
 * the same row. Every write is an `updateMany` guarded on what was read (the
 * send count for a send, the code hash for a verify or a miss), so a lost
 * race changes nothing and is re-read rather than overwritten. The row is
 * created with `createMany({ skipDuplicates })`, never by catching a unique
 * violation (CLAUDE.md).
 *
 * TIME. `createdAt` is written from this process's clock, and `verifiedAt` is
 * clamped to at least `createdAt`, so a database clock ahead of ours can
 * never trip LoginVerification_verified_after_created.
 */
@Injectable()
export class LoginCodeService {
  private readonly logger = new Logger(LoginCodeService.name);
  private readonly pepper: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    private readonly email: EmailService,
    private readonly gate: LoginGateService,
  ) {
    this.pepper = config.get('IP_HASH_PEPPER', { infer: true });
  }

  async send(user: AuthUser, session: AuthSession): Promise<LoginCodeSendResult> {
    if (await this.gate.isVerified(session)) return { verified: true };

    const now = new Date();
    await this.prisma.loginVerification.createMany({
      data: [{ sessionId: session.sessionId, userId: user.id, createdAt: now }],
      skipDuplicates: true,
    });
    const row = await this.load(user, session);
    if (row.verifiedAt !== null) {
      this.gate.remember(session.sessionId);
      return { verified: true };
    }

    const pending = this.pendingState(user, row, now);
    if (pending !== null) return pending;

    if (row.sendCount >= LOGIN_CODE_MAX_SENDS_PER_SIGN_IN) throw this.sendLimit();
    if ((await this.sentInLastHour(user.id, now)) >= LOGIN_CODE_MAX_SENDS_PER_HOUR) {
      throw this.sendLimit();
    }
    if (!this.email.enabled) throw this.emailFailed();

    const code = generateLoginCode();
    const codeHash = hashLoginCode(this.pepper, session.sessionId, code);
    const expiresAt = new Date(now.getTime() + LOGIN_CODE_TTL_MS);

    // Claim the send. `sendCount` is the version: every send bumps it, so a
    // concurrent send that got here first makes this match nothing.
    const claimed = await this.prisma.loginVerification.updateMany({
      where: { sessionId: session.sessionId, verifiedAt: null, sendCount: row.sendCount },
      data: {
        codeHash,
        codeExpiresAt: expiresAt,
        attempts: 0,
        sendCount: { increment: 1 },
        lastSentAt: now,
      },
    });
    if (claimed.count === 0) {
      const fresh = await this.load(user, session);
      if (fresh.verifiedAt !== null) {
        this.gate.remember(session.sessionId);
        return { verified: true };
      }
      // The winner's code is the live one. If there is none, the winner's
      // email failed and was un-counted — say so rather than send a second.
      const winner = this.pendingState(user, fresh, now);
      if (winner === null) throw this.emailFailed();
      return winner;
    }

    try {
      await this.email.sendLoginCode(user.email, { name: user.firstName, code });
    } catch (error) {
      this.logger.warn(`Sign-in code email failed for user ${user.id}: ${(error as Error).message}`);
      // Not counted as sent (spec): put the row back as it was, so the
      // previous code — if any — keeps working.
      await this.prisma.loginVerification.updateMany({
        where: { sessionId: session.sessionId, codeHash },
        data: {
          codeHash: row.codeHash,
          codeExpiresAt: row.codeExpiresAt,
          attempts: row.attempts,
          sendCount: { decrement: 1 },
          lastSentAt: row.lastSentAt,
        },
      });
      throw this.emailFailed();
    }

    return {
      verified: false,
      sentTo: maskEmail(user.email),
      resendAvailableAt: new Date(now.getTime() + LOGIN_CODE_RESEND_COOLDOWN_MS).toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verify(user: AuthUser, session: AuthSession, code: string): Promise<LoginCodeVerified> {
    if (await this.gate.isVerified(session)) return { verified: true };

    const now = new Date();
    const row = await this.prisma.loginVerification.findUnique({
      where: { sessionId: session.sessionId },
    });
    if (row === null || row.userId !== user.id || row.codeHash === null || row.codeExpiresAt === null) {
      throw this.expired();
    }
    if (row.attempts >= LOGIN_CODE_MAX_ATTEMPTS) throw this.locked();
    if (now.getTime() >= row.codeExpiresAt.getTime()) throw this.expired();

    const presented = hashLoginCode(this.pepper, session.sessionId, code);

    if (loginCodeMatches(presented, row.codeHash)) {
      const done = await this.prisma.loginVerification.updateMany({
        where: {
          sessionId: session.sessionId,
          codeHash: row.codeHash,
          verifiedAt: null,
          attempts: { lt: LOGIN_CODE_MAX_ATTEMPTS },
        },
        data: {
          verifiedAt: new Date(Math.max(now.getTime(), row.createdAt.getTime())),
          codeHash: null,
          codeExpiresAt: null,
        },
      });
      if (done.count === 0) {
        // Another tab verified first (fine), or a resend replaced this code.
        const fresh = await this.prisma.loginVerification.findUnique({
          where: { sessionId: session.sessionId },
        });
        if (fresh === null || fresh.verifiedAt === null) throw this.expired();
      }
      this.gate.remember(session.sessionId);
      return { verified: true };
    }

    // A miss counts only against the code it was a guess at.
    const missed = await this.prisma.loginVerification.updateMany({
      where: {
        sessionId: session.sessionId,
        codeHash: row.codeHash,
        attempts: { lt: LOGIN_CODE_MAX_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
    });
    if (missed.count === 0) {
      const fresh = await this.prisma.loginVerification.findUnique({
        where: { sessionId: session.sessionId },
      });
      if (fresh !== null && fresh.verifiedAt !== null) return { verified: true };
      if (fresh === null || fresh.attempts >= LOGIN_CODE_MAX_ATTEMPTS) throw this.locked();
      throw this.invalid(LOGIN_CODE_MAX_ATTEMPTS - fresh.attempts);
    }

    const attemptsLeft = LOGIN_CODE_MAX_ATTEMPTS - (row.attempts + 1);
    if (attemptsLeft <= 0) throw this.locked();
    throw this.invalid(attemptsLeft);
  }

  private async load(user: AuthUser, session: AuthSession): Promise<CodeRow> {
    const row = await this.prisma.loginVerification.findUnique({
      where: { sessionId: session.sessionId },
    });
    // A session id is one account's; a row naming another account is never ours.
    if (row === null || row.userId !== user.id) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return row;
  }

  /** The code already on its way, when the last send is inside the cooldown. */
  private pendingState(user: AuthUser, row: CodeRow, now: Date): LoginCodeSendResult | null {
    if (row.lastSentAt === null || row.codeExpiresAt === null) return null;
    const resendAt = row.lastSentAt.getTime() + LOGIN_CODE_RESEND_COOLDOWN_MS;
    if (now.getTime() >= resendAt) return null;
    return {
      verified: false,
      sentTo: maskEmail(user.email),
      resendAvailableAt: new Date(resendAt).toISOString(),
      expiresAt: row.codeExpiresAt.toISOString(),
    };
  }

  /**
   * Codes sent to this account in the last hour, as SUM(sendCount) over rows
   * last sent within it. Every send of a row happened at or before its
   * lastSentAt, so this can only OVERcount (refuse early), never let an
   * eleventh code through — and it needs no send log.
   */
  private async sentInLastHour(userId: string, now: Date): Promise<number> {
    const result = await this.prisma.loginVerification.aggregate({
      where: { userId, lastSentAt: { gt: new Date(now.getTime() - LOGIN_CODE_HOUR_MS) } },
      _sum: { sendCount: true },
    });
    return result._sum.sendCount ?? 0;
  }

  private sendLimit(): DomainException {
    return new DomainException(
      'LOGIN_CODE_SEND_LIMIT',
      'Too many sign-in codes have been sent. Wait a while, then sign in again.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private emailFailed(): DomainException {
    return new DomainException(
      'LOGIN_CODE_EMAIL_FAILED',
      "We couldn't send the email. Ask the gym.",
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private invalid(attemptsLeft: number): DomainException {
    return new DomainException(
      'LOGIN_CODE_INVALID',
      "That code isn't right.",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { attemptsLeft },
    );
  }

  private expired(): DomainException {
    return new DomainException('LOGIN_CODE_EXPIRED', 'That code has expired. Send a new one.');
  }

  private locked(): DomainException {
    return new DomainException('LOGIN_CODE_LOCKED', 'Too many wrong tries. Send a new code.');
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test --workspace=server -- login-code.service`
Expected: PASS (all `send` and `verify` cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/login-code/login-code.service.ts server/src/auth/login-code/login-code.service.spec.ts
git commit -m "feat(login-code): issue and verify the emailed code with caps and race guards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `POST /auth/login-code` and `POST /auth/login-code/verify`

**Files:**
- Create: `server/src/auth/decorators/current-auth-session.decorator.ts`
- Create: `server/src/auth/login-code/verify-login-code.dto.ts`
- Test: `server/src/auth/login-code/verify-login-code.dto.spec.ts`
- Create: `server/src/auth/login-code/login-code.controller.ts`
- Test: `server/src/auth/login-code/login-code.controller.spec.ts`
- Modify: `server/src/auth/auth.module.ts`

**Interfaces:**
- Consumes: `LoginCodeService.send` / `.verify` (Task 6); `AllowUnverifiedLogin`, `ALLOW_UNVERIFIED_LOGIN_KEY` (Task 4); `request.authSession` (Task 4).
- Produces: `CurrentAuthSession` param decorator; `VerifyLoginCodeDto { code: string }`; the routes `POST /api/v1/auth/login-code` → `LoginCodeSendResult` and `POST /api/v1/auth/login-code/verify` → `LoginCodeVerified`, both returning 200.

- [ ] **Step 1: Write the failing tests**

Create `server/src/auth/login-code/verify-login-code.dto.spec.ts`:

```ts
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VerifyLoginCodeDto } from './verify-login-code.dto';

async function check(code: unknown): Promise<{ dto: VerifyLoginCodeDto; valid: boolean }> {
  const dto = plainToInstance(VerifyLoginCodeDto, { code });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, valid: errors.length === 0 };
}

describe('VerifyLoginCodeDto', () => {
  it.each([
    ['123456', '123456'],
    ['012345', '012345'],
    [' 123456 ', '123456'],
    ['123 456', '123456'],
  ])('accepts %p as %p — spaces from a copy-paste are dropped', async (raw, expected) => {
    const { dto, valid } = await check(raw);
    expect(valid).toBe(true);
    expect(dto.code).toBe(expected);
  });

  it.each(['12345', '1234567', '12345a', '', '１２３４５６', null, undefined])(
    'refuses %p',
    async (raw) => {
      expect((await check(raw)).valid).toBe(false);
    },
  );

  it('refuses an unknown extra field', async () => {
    const dto = plainToInstance(VerifyLoginCodeDto, { code: '123456', remember: true });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.length).toBeGreaterThan(0);
  });
});
```

Create `server/src/auth/login-code/login-code.controller.spec.ts`:

```ts
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_UNVERIFIED_LOGIN_KEY } from '../decorators/allow-unverified-login.decorator';
import type { AuthSession, AuthUser } from '../auth.types';
import { LoginCodeController } from './login-code.controller';
import type { LoginCodeService } from './login-code.service';

const USER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } as AuthUser;
const SESSION: AuthSession = {
  sessionId: '99999999-9999-4999-8999-999999999999',
  viaEmailLink: false,
};

/**
 * The decorators ARE the access rule and the abuse bound on these routes, and
 * a dropped one fails no behavioural test — so they are asserted directly.
 */
describe('LoginCodeController', () => {
  const proto = LoginCodeController.prototype;
  const meta = (key: string, name: keyof LoginCodeController): unknown =>
    // Reading metadata off the function object, never calling it.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Reflect.getMetadata(key, proto[name]);

  it('is open to an unverified sign-in, at the class level', () => {
    expect(Reflect.getMetadata(ALLOW_UNVERIFIED_LOGIN_KEY, LoginCodeController)).toBe(true);
  });

  it.each(['send', 'verify'] as const)('%s still needs a token — it is not @Public()', (name) => {
    expect(meta(IS_PUBLIC_KEY, name)).toBeUndefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, LoginCodeController)).toBeUndefined();
  });

  it('send throttles default 5/min and origin 30/min', () => {
    expect(meta('THROTTLER:LIMITdefault', 'send')).toBe(5);
    expect(meta('THROTTLER:TTLdefault', 'send')).toBe(60_000);
    expect(meta('THROTTLER:LIMITorigin', 'send')).toBe(30);
    expect(meta('THROTTLER:TTLorigin', 'send')).toBe(60_000);
  });

  it('verify throttles default 10/min and origin 60/min', () => {
    expect(meta('THROTTLER:LIMITdefault', 'verify')).toBe(10);
    expect(meta('THROTTLER:TTLdefault', 'verify')).toBe(60_000);
    expect(meta('THROTTLER:LIMITorigin', 'verify')).toBe(60);
    expect(meta('THROTTLER:TTLorigin', 'verify')).toBe(60_000);
  });

  it.each(['send', 'verify'] as const)('%s answers 200, not 201', (name) => {
    expect(meta(HTTP_CODE_METADATA, name)).toBe(200);
  });

  describe('forwarding', () => {
    const service = {
      send: jest.fn().mockResolvedValue('sent'),
      verify: jest.fn().mockResolvedValue('verified'),
    };
    const controller = new LoginCodeController(service as unknown as LoginCodeService);

    it('send passes the caller and their sign-in', async () => {
      await expect(controller.send(USER, SESSION)).resolves.toBe('sent');
      expect(service.send).toHaveBeenCalledWith(USER, SESSION);
    });

    it('verify passes the caller, their sign-in and the code', async () => {
      await expect(controller.verify({ code: '123456' }, USER, SESSION)).resolves.toBe('verified');
      expect(service.verify).toHaveBeenCalledWith(USER, SESSION, '123456');
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test --workspace=server -- verify-login-code login-code.controller`
Expected: FAIL. The modules are missing.

- [ ] **Step 3: Implement the decorator, the DTO, the controller and the wiring**

Create `server/src/auth/decorators/current-auth-session.decorator.ts`:

```ts
import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthSession } from '../auth.types';

/**
 * Injects the sign-in AuthGuard attached (`request.authSession`). Throws, like
 * @CurrentUser(), when the guard did not run, rather than handing a handler
 * an undefined session.
 */
export const CurrentAuthSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthSession => {
    const request = ctx.switchToHttp().getRequest<Request & { authSession?: AuthSession }>();

    if (!request.authSession) {
      throw new Error('@CurrentAuthSession() used on a route that AuthGuard did not populate');
    }

    return request.authSession;
  },
);
```

Create `server/src/auth/login-code/verify-login-code.dto.ts`:

```ts
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

/** Every whitespace character goes: "123 456" pasted from an email is still the code. */
const withoutSpaces = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replace(/\s+/g, '') : value;

/** Body of `POST /auth/login-code/verify`. Exactly six ASCII digits after spaces are dropped. */
export class VerifyLoginCodeDto {
  @Transform(withoutSpaces)
  @IsString()
  @Matches(/^[0-9]{6}$/, { message: 'code must be exactly 6 digits' })
  code!: string;
}
```

Create `server/src/auth/login-code/login-code.controller.ts`:

```ts
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { LoginCodeSendResult, LoginCodeVerified } from '@got/shared';
import { AllowUnverifiedLogin } from '../decorators/allow-unverified-login.decorator';
import { CurrentAuthSession } from '../decorators/current-auth-session.decorator';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { AuthSession, AuthUser } from '../auth.types';
import { LoginCodeService } from './login-code.service';
import { VerifyLoginCodeDto } from './verify-login-code.dto';

/**
 * The emailed sign-in code's two calls. Authenticated (the Supabase token is
 * required) but open to a sign-in that has not entered its code yet — the
 * only two routes in the API that are.
 */
@Controller('auth/login-code')
@AllowUnverifiedLogin()
export class LoginCodeController {
  constructor(private readonly codes: LoginCodeService) {}

  /** Sends (or re-sends) a code for the caller's current sign-in. */
  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 }, origin: { limit: 30, ttl: 60_000 } })
  async send(
    @CurrentUser() user: AuthUser,
    @CurrentAuthSession() session: AuthSession,
  ): Promise<LoginCodeSendResult> {
    return this.codes.send(user, session);
  }

  @Post('verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 }, origin: { limit: 60, ttl: 60_000 } })
  async verify(
    @Body() dto: VerifyLoginCodeDto,
    @CurrentUser() user: AuthUser,
    @CurrentAuthSession() session: AuthSession,
  ): Promise<LoginCodeVerified> {
    return this.codes.verify(user, session, dto.code);
  }
}
```

In `server/src/auth/auth.module.ts`, import `LoginCodeController` and `LoginCodeService`, add `controllers: [LoginCodeController],` to the `@Module` metadata, and add `LoginCodeService` to `providers`. Update the module's doc comment with one line: "It also owns the emailed sign-in code: `LoginCodeController` and the gate both guards call."

- [ ] **Step 4: Run them, plus the whole server unit suite**

Run: `npm test --workspace=server -- verify-login-code login-code.controller`
Expected: PASS.

Run: `npm test --workspace=server`
Expected: PASS, with no unrelated failures.

- [ ] **Step 5: Commit**

```bash
git add server/src/auth
git commit -m "feat(login-code): POST /auth/login-code and /auth/login-code/verify

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Client — `apiFetch` redirect and the login-code helpers

**Files:**
- Create: `client/src/lib/loginCodeRedirect.ts`
- Test: `client/src/lib/loginCodeRedirect.test.ts`
- Modify: `client/src/lib/api.ts` (the `!response.ok || !body.success` branch)
- Test: `client/src/lib/api.test.ts`
- Create: `client/src/lib/loginCode.ts`
- Test: `client/src/lib/loginCode.test.ts`

**Interfaces:**
- Consumes: `LoginCodeSendResult`, `LoginCodeVerified`, `LoginCodeInvalidDetails` from `@got/shared` (Task 1); the server routes (Task 7).
- Produces (`loginCodeRedirect.ts`): `LOGIN_CODE_REQUIRED = 'LOGIN_CODE_REQUIRED'`, `loginCodeRedirectFor(pathname: string, search: string): string | null`, `browserNavigation: { assign(url: string): void }`.
- Produces (`loginCode.ts`): `LOGIN_CODE_DIGITS = 6`, `sendLoginCode(token?: string): Promise<LoginCodeSendResult>`, `verifyLoginCode(code: string): Promise<LoginCodeVerified>`, `normaliseCodeInput(raw: string): string`, `isCompleteCode(code: string): boolean`, `secondsUntil(iso: string | null, nowMs: number): number`, `resendLabel(secondsLeft: number): string`, `classifyMeFailure(caught: unknown): 'code-required' | 'signed-out' | 'retry'`, `loginCodeErrorMessage(caught: unknown): string`.

- [ ] **Step 1: Write the failing tests**

Create `client/src/lib/loginCodeRedirect.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loginCodeRedirectFor } from './loginCodeRedirect';

describe('loginCodeRedirectFor', () => {
  it('sends a portal page to /login with the page and its query as next', () => {
    expect(loginCodeRedirectFor('/portal/bookings', '?tab=past')).toBe(
      '/login?next=%2Fportal%2Fbookings%3Ftab%3Dpast',
    );
  });

  it('sends the console and the desk too', () => {
    expect(loginCodeRedirectFor('/admin/members', '')).toBe('/login?next=%2Fadmin%2Fmembers');
    expect(loginCodeRedirectFor('/desk/station', '')).toBe('/login?next=%2Fdesk%2Fstation');
  });

  it.each([
    ['/login', ''],
    ['/login', '?next=%2Fadmin'],
    ['/join/abc123', ''],
    ['/invite/xyz', ''],
    ['/reset-password', ''],
  ])('leaves %s%s alone — that page handles the code itself', (pathname, search) => {
    expect(loginCodeRedirectFor(pathname, search)).toBeNull();
  });

  it('matches whole path segments, not prefixes', () => {
    expect(loginCodeRedirectFor('/loginhelp', '')).toBe('/login?next=%2Floginhelp');
  });
});
```

In `client/src/lib/api.test.ts`, add `type MockInstance` to the vitest import, import `{ browserNavigation } from './loginCodeRedirect'`, and append a new top-level describe:

```ts
describe('apiFetch — LOGIN_CODE_REQUIRED', () => {
  let assign: MockInstance<(url: string) => void>;

  const required = (): Response =>
    jsonResponse(
      {
        success: false,
        error: { code: 'LOGIN_CODE_REQUIRED', message: 'Enter the 6-digit code we emailed you.' },
      },
      401,
    );

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => undefined);
  });

  afterEach(() => {
    assign.mockRestore();
    window.history.pushState({}, '', '/');
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('sends the browser to /login with this page as next, and still throws the ApiError', async () => {
    window.history.pushState({}, '', '/portal/bookings?tab=past');
    vi.mocked(fetch).mockResolvedValue(required());

    await expect(apiFetch('/me')).rejects.toMatchObject({
      status: 401,
      code: 'LOGIN_CODE_REQUIRED',
    });
    expect(assign).toHaveBeenCalledWith('/login?next=%2Fportal%2Fbookings%3Ftab%3Dpast');
  });

  it('stays on /login, which shows the code step itself', async () => {
    window.history.pushState({}, '', '/login?next=%2Fadmin');
    vi.mocked(fetch).mockResolvedValue(required());

    await expect(apiFetch('/me')).rejects.toMatchObject({ code: 'LOGIN_CODE_REQUIRED' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not navigate on an ordinary 401', async () => {
    window.history.pushState({}, '', '/portal/dashboard');
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: false }, 401));

    await expect(apiFetch('/me')).rejects.toMatchObject({ status: 401, code: 'HTTP_401' });
    expect(assign).not.toHaveBeenCalled();
  });
});
```

Create `client/src/lib/loginCode.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}));

import { ApiError } from './api';
import {
  classifyMeFailure,
  isCompleteCode,
  loginCodeErrorMessage,
  normaliseCodeInput,
  resendLabel,
  secondsUntil,
} from './loginCode';

const err = (code: string, status = 422, details?: unknown): ApiError =>
  new ApiError('server words', status, code, details);

describe('normaliseCodeInput', () => {
  it.each([
    ['123456', '123456'],
    ['123 456', '123456'],
    [' 12-34-56 ', '123456'],
    ['Your code: 654321', '654321'],
    ['1234567', '123456'],
    ['abc', ''],
  ])('%p → %p', (raw, expected) => {
    expect(normaliseCodeInput(raw)).toBe(expected);
  });
});

describe('isCompleteCode', () => {
  it('wants exactly six digits', () => {
    expect(isCompleteCode('123456')).toBe(true);
    expect(isCompleteCode('12345')).toBe(false);
    expect(isCompleteCode('12345a')).toBe(false);
  });
});

describe('secondsUntil', () => {
  const now = Date.parse('2026-10-15T02:00:00.000Z');

  it('rounds up, so the button never says 0:00 while still disabled', () => {
    expect(secondsUntil('2026-10-15T02:00:41.200Z', now)).toBe(42);
  });

  it('is 0 at and after the instant, and for nothing or nonsense', () => {
    expect(secondsUntil('2026-10-15T02:00:00.000Z', now)).toBe(0);
    expect(secondsUntil('2026-10-15T01:59:00.000Z', now)).toBe(0);
    expect(secondsUntil(null, now)).toBe(0);
    expect(secondsUntil('not a date', now)).toBe(0);
  });
});

describe('resendLabel', () => {
  it('counts down as m:ss, then offers the button', () => {
    expect(resendLabel(42)).toBe('Resend code in 0:42');
    expect(resendLabel(60)).toBe('Resend code in 1:00');
    expect(resendLabel(0)).toBe('Resend code');
  });
});

describe('classifyMeFailure', () => {
  it('sends LOGIN_CODE_REQUIRED to the code step — never to sign-out', () => {
    expect(classifyMeFailure(err('LOGIN_CODE_REQUIRED', 401))).toBe('code-required');
  });

  it('treats any other 401 as a dead session', () => {
    expect(classifyMeFailure(err('HTTP_401', 401))).toBe('signed-out');
  });

  it('retries everything else, including a bare network TypeError', () => {
    expect(classifyMeFailure(err('HTTP_500', 500))).toBe('retry');
    expect(classifyMeFailure(new TypeError('Failed to fetch'))).toBe('retry');
  });
});

describe('loginCodeErrorMessage', () => {
  it('says how many tries are left on a wrong code', () => {
    expect(loginCodeErrorMessage(err('LOGIN_CODE_INVALID', 422, { attemptsLeft: 3 }))).toBe(
      "That code isn't right. 3 tries left.",
    );
    expect(loginCodeErrorMessage(err('LOGIN_CODE_INVALID', 422, { attemptsLeft: 1 }))).toBe(
      "That code isn't right. 1 try left.",
    );
  });

  it.each([
    ['LOGIN_CODE_INVALID', 422, "That code isn't right. Check the email and try again."],
    ['LOGIN_CODE_EXPIRED', 422, 'That code has expired. Tap Resend code for a new one.'],
    ['LOGIN_CODE_LOCKED', 422, 'Too many wrong tries. Tap Resend code for a new one.'],
    [
      'LOGIN_CODE_SEND_LIMIT',
      429,
      "We've sent as many codes as we can for now. Wait a while, then sign in again.",
    ],
    ['LOGIN_CODE_EMAIL_FAILED', 503, "We couldn't send the email — ask the gym."],
    ['HTTP_400', 400, 'Enter the 6-digit code from the email.'],
    ['HTTP_429', 429, 'Too many tries. Wait a minute, then try again.'],
    ['HTTP_500', 500, 'Something went wrong. Please try again.'],
  ])('%s reads as words, never as a code', (code, status, expected) => {
    expect(loginCodeErrorMessage(err(code, status))).toBe(expected);
  });

  it('explains a network failure', () => {
    expect(loginCodeErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'Something went wrong. Check your connection and try again.',
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test --workspace=client -- loginCode api.test`
Expected: FAIL. The modules are missing, and `apiFetch` never calls `assign`.

- [ ] **Step 3: Implement**

Create `client/src/lib/loginCodeRedirect.ts`:

```ts
/**
 * Where a page goes when the API answers `401 LOGIN_CODE_REQUIRED`: this
 * sign-in has not entered its emailed code yet. Pure, so `apiFetch`'s rule is
 * testable without a browser navigation.
 */
export const LOGIN_CODE_REQUIRED = 'LOGIN_CODE_REQUIRED';

/**
 * Pages that deal with an unverified sign-in themselves: the login page shows
 * the code step, and the join/invite/reset pages run on email-link sessions,
 * which the server already counts as verified.
 */
const SELF_HANDLING_ROOTS = ['/login', '/join', '/invite', '/reset-password'] as const;

/** `/login?next=<this page>`, or null when this page handles the code itself. */
export function loginCodeRedirectFor(pathname: string, search: string): string | null {
  const handled = SELF_HANDLING_ROOTS.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  );
  if (handled) return null;
  return `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
}

/** The navigation seam: tests spy on `assign`; the app does a real full-page load. */
export const browserNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};
```

In `client/src/lib/api.ts`, add `import { LOGIN_CODE_REQUIRED, browserNavigation, loginCodeRedirectFor } from './loginCodeRedirect';` after the existing imports. Replace the failure branch with:

```ts
  if (!response.ok || !body.success) {
    if (response.status === 403) notifyForbidden(path);
    const error = new ApiError(
      body.error?.message ?? `Request failed with ${response.status}`,
      response.status,
      body.error?.code ?? `HTTP_${response.status}`,
      body.error?.details,
    );
    if (error.code === LOGIN_CODE_REQUIRED) redirectForLoginCode();
    throw error;
  }
```

Add below `notifyForbidden`:

```ts
/**
 * The sign-in has not entered its emailed code: send the browser to the login
 * page's code step, which comes back here afterwards. The caller still gets
 * its ApiError — navigation is a side effect, never a substitute for the throw.
 */
function redirectForLoginCode(): void {
  if (typeof window === 'undefined') return;
  const target = loginCodeRedirectFor(window.location.pathname, window.location.search);
  if (target !== null) browserNavigation.assign(target);
}
```

Create `client/src/lib/loginCode.ts`:

```ts
'use client';

import type { LoginCodeInvalidDetails, LoginCodeSendResult, LoginCodeVerified } from '@got/shared';
import { ApiError, apiFetch } from './api';
import { LOGIN_CODE_REQUIRED } from './loginCodeRedirect';

/**
 * The login page's second step: password, then a 6-digit code emailed by our
 * API. Everything here is the page's logic without React, so it can be tested.
 */
export const LOGIN_CODE_DIGITS = 6;

/**
 * `token` is passed straight after `signInWithPassword`, because Supabase
 * stores the new session asynchronously and `getSession()` can still return
 * the old one for a moment (see LoginPage).
 */
export function sendLoginCode(token?: string): Promise<LoginCodeSendResult> {
  return apiFetch<LoginCodeSendResult>('/auth/login-code', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export function verifyLoginCode(code: string): Promise<LoginCodeVerified> {
  return apiFetch<LoginCodeVerified>('/auth/login-code/verify', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

/** Digits only, at most six — what a paste of "123 456" or "Your code: 123456" should become. */
export function normaliseCodeInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, LOGIN_CODE_DIGITS);
}

export function isCompleteCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** Whole seconds until `iso`, rounded up; 0 when past, absent or unreadable. */
export function secondsUntil(iso: string | null, nowMs: number): number {
  if (iso === null) return 0;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

export function resendLabel(secondsLeft: number): string {
  if (secondsLeft <= 0) return 'Resend code';
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  return `Resend code in ${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * What a failed `/me` means on the login page. LOGIN_CODE_REQUIRED is a 401
 * too, and must NOT reach the "session could not be verified → sign out"
 * branch: the session is fine, it just needs its code.
 */
export function classifyMeFailure(caught: unknown): 'code-required' | 'signed-out' | 'retry' {
  if (caught instanceof ApiError && caught.code === LOGIN_CODE_REQUIRED) return 'code-required';
  if (caught instanceof ApiError && caught.status === 401) return 'signed-out';
  return 'retry';
}

function attemptsLeftOf(details: unknown): number | null {
  if (details === null || typeof details !== 'object') return null;
  const left = (details as Partial<LoginCodeInvalidDetails>).attemptsLeft;
  return typeof left === 'number' ? left : null;
}

/** Every failure of the code step, in words. Never shows a raw code. */
export function loginCodeErrorMessage(caught: unknown): string {
  if (!(caught instanceof ApiError)) {
    return 'Something went wrong. Check your connection and try again.';
  }
  switch (caught.code) {
    case 'LOGIN_CODE_INVALID': {
      const left = attemptsLeftOf(caught.details);
      return left === null
        ? "That code isn't right. Check the email and try again."
        : `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
    }
    case 'LOGIN_CODE_EXPIRED':
      return 'That code has expired. Tap Resend code for a new one.';
    case 'LOGIN_CODE_LOCKED':
      return 'Too many wrong tries. Tap Resend code for a new one.';
    case 'LOGIN_CODE_SEND_LIMIT':
      return "We've sent as many codes as we can for now. Wait a while, then sign in again.";
    case 'LOGIN_CODE_EMAIL_FAILED':
      return "We couldn't send the email — ask the gym.";
    case 'HTTP_400':
      return 'Enter the 6-digit code from the email.';
    case 'HTTP_429':
      return 'Too many tries. Wait a minute, then try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test --workspace=client -- loginCode api.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/loginCodeRedirect.ts client/src/lib/loginCodeRedirect.test.ts client/src/lib/api.ts client/src/lib/api.test.ts client/src/lib/loginCode.ts client/src/lib/loginCode.test.ts
git commit -m "feat(login-code): apiFetch sends an unverified sign-in to the code step; code-step helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Client — the login page's code step

**Files:**
- Create: `client/src/components/auth/LoginCodeStep.tsx`
- Test: `client/src/components/auth/LoginCodeStep.test.tsx`
- Modify: `client/src/components/auth/LoginPage.tsx`

**Interfaces:**
- Consumes: everything from `client/src/lib/loginCode.ts` (Task 8); `LoginCodePending` from `@got/shared`.
- Produces: `LoginCodeStep(props: LoginCodeStepProps)`, where `LoginCodeStepProps = { sentTo: string | null; code: string; error: string | null; verifying: boolean; resending: boolean; resendSecondsLeft: number; onCodeChange(code: string): void; onVerify(): void; onResend(): void; onSwitchAccount(): void }`.

- [ ] **Step 1: Write the failing component test**

Create `client/src/components/auth/LoginCodeStep.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// loginCode.ts imports the API client, which needs Supabase's env at import.
// Nothing here talks to the network (same approach as SessionCard.test.tsx).
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { LoginCodeStep, type LoginCodeStepProps } from './LoginCodeStep';

const noop = (): void => undefined;

const render = (over: Partial<LoginCodeStepProps> = {}): string =>
  renderToStaticMarkup(
    <LoginCodeStep
      sentTo="ju***@gmail.com"
      code=""
      error={null}
      verifying={false}
      resending={false}
      resendSecondsLeft={0}
      onCodeChange={noop}
      onVerify={noop}
      onResend={noop}
      onSwitchAccount={noop}
      {...over}
    />,
  );

/** The opening tag of the button whose text is `label`. */
const buttonTag = (html: string, label: string): string => {
  const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
  expect(match).not.toBeNull();
  return (match as RegExpExecArray)[0];
};

describe('LoginCodeStep', () => {
  it('says where the code went, masked', () => {
    expect(render()).toContain('We emailed a 6-digit code to <strong>ju***@gmail.com</strong>');
  });

  it('says plainly when no code went out', () => {
    // react-dom/server escapes the apostrophe.
    expect(render({ sentTo: null })).toContain('We couldn&#x27;t email you a code yet.');
  });

  it('has one numeric one-time-code input of six characters', () => {
    const html = render();
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('maxLength="6"');
  });

  it('keeps Verify disabled until six digits are in', () => {
    expect(buttonTag(render({ code: '12345' }), 'VERIFY')).toContain('disabled');
    expect(buttonTag(render({ code: '123456' }), 'VERIFY')).not.toContain('disabled');
  });

  it('shows VERIFYING… and stays disabled while a check is in flight', () => {
    expect(buttonTag(render({ code: '123456', verifying: true }), 'VERIFYING…')).toContain(
      'disabled',
    );
  });

  it('counts down Resend and disables it until then', () => {
    expect(buttonTag(render({ resendSecondsLeft: 42 }), 'Resend code in 0:42')).toContain(
      'disabled',
    );
    expect(buttonTag(render({ resendSecondsLeft: 0 }), 'Resend code')).not.toContain('disabled');
  });

  it('shows the error as an alert, in words', () => {
    const html = render({ error: "That code isn't right. 3 tries left." });
    expect(html).toContain('role="alert"');
    expect(html).toContain('That code isn&#x27;t right. 3 tries left.');
  });

  it('offers a way out to another account', () => {
    expect(buttonTag(render(), 'Use a different account')).not.toContain('disabled');
  });
});
```

(Checked against this repo's React 19.2.8: `renderToStaticMarkup` prints `inputMode="numeric"`, `autoComplete="one-time-code"`, `maxLength="6"`, `disabled=""`, and escapes `'` as `&#x27;`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace=client -- LoginCodeStep`
Expected: FAIL. `./LoginCodeStep` cannot be found.

- [ ] **Step 3: Write the component**

Create `client/src/components/auth/LoginCodeStep.tsx`:

```tsx
'use client';

import { isCompleteCode, normaliseCodeInput, resendLabel } from '@/lib/loginCode';

export interface LoginCodeStepProps {
  /** Masked address, or null when the first send failed. */
  sentTo: string | null;
  code: string;
  error: string | null;
  verifying: boolean;
  resending: boolean;
  resendSecondsLeft: number;
  onCodeChange: (code: string) => void;
  onVerify: () => void;
  onResend: () => void;
  onSwitchAccount: () => void;
}

/**
 * The second step of signing in: the 6-digit code from the email. Purely
 * presentational — LoginPage owns the state and the calls.
 */
export function LoginCodeStep({
  sentTo,
  code,
  error,
  verifying,
  resending,
  resendSecondsLeft,
  onCodeChange,
  onVerify,
  onResend,
  onSwitchAccount,
}: LoginCodeStepProps) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onVerify();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
    >
      <p style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--text-2)', margin: 0 }}>
        {sentTo === null ? (
          "We couldn't email you a code yet."
        ) : (
          <>
            We emailed a 6-digit code to <strong>{sentTo}</strong>. It works for 10 minutes.
          </>
        )}
      </p>

      <div className="field">
        <label htmlFor="login-code">Sign-in code</label>
        <input
          id="login-code"
          className="input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          placeholder="123456"
          value={code}
          onChange={(e) => onCodeChange(normaliseCodeInput(e.target.value))}
          // maxLength cuts a pasted "123 456" to "123 45" BEFORE onChange runs,
          // so a paste is read from the clipboard and normalised here instead.
          onPaste={(e) => {
            e.preventDefault();
            onCodeChange(normaliseCodeInput(e.clipboardData.getData('text')));
          }}
          autoFocus
          required
          style={{ fontSize: 22, letterSpacing: '0.4em', textAlign: 'center' }}
        />
      </div>

      {error && (
        <div
          role="alert"
          style={{
            padding: '11px 14px',
            borderRadius: 7,
            border: '1px solid rgba(255,90,70,.4)',
            background: 'rgba(255,90,70,.1)',
            color: '#ff9d92',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={verifying || !isCompleteCode(code)}
        className="btn btn-gold btn-block"
        style={{
          padding: 14,
          fontSize: 14.5,
          letterSpacing: '0.12em',
          opacity: verifying || !isCompleteCode(code) ? 0.6 : 1,
          cursor: verifying || !isCompleteCode(code) ? 'not-allowed' : 'pointer',
        }}
      >
        {verifying ? 'VERIFYING…' : 'VERIFY'}
      </button>

      <button
        type="button"
        disabled={resending || resendSecondsLeft > 0}
        onClick={onResend}
        className="btn btn-ghost btn-block"
        style={{ padding: 13, fontSize: 13.5, letterSpacing: '0.06em' }}
      >
        {resending ? 'Sending…' : resendLabel(resendSecondsLeft)}
      </button>

      <button
        type="button"
        onClick={onSwitchAccount}
        style={{
          alignSelf: 'center',
          background: 'none',
          border: 0,
          padding: 0,
          color: 'var(--gold)',
          fontSize: 12.5,
          cursor: 'pointer',
        }}
      >
        Use a different account
      </button>
    </form>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test --workspace=client -- LoginCodeStep`
Expected: PASS.

- [ ] **Step 5: Give `LoginPage` its second step**

In `client/src/components/auth/LoginPage.tsx`:

Replace the imports with:

```tsx
import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { LoginCodePending } from '@got/shared';
import AuthBrandPanel from './AuthBrandPanel';
import { LoginCodeStep } from './LoginCodeStep';
import { supabase } from '@/lib/supabase';
import { type HeldPermission, destinationFor } from '@/lib/safeNext';
import { EMAIL_INPUT_PROPS, normaliseIdentifier, normalisePassword } from '@/lib/credentials';
import { apiFetch } from '@/lib/api';
import {
  classifyMeFailure,
  isCompleteCode,
  loginCodeErrorMessage,
  secondsUntil,
  sendLoginCode,
  verifyLoginCode,
} from '@/lib/loginCode';
import { PasswordInput } from './PasswordInput';
```

After the existing `const [submitting, setSubmitting] = useState(false);`, add:

```tsx
  // ── The emailed sign-in code (second step) ──
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [pending, setPending] = useState<LoginCodePending | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // The Resend countdown ticks only while the code step is on screen.
  useEffect(() => {
    if (step !== 'code') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [step]);
```

Keep `routeByPermissions` as it is. Add these functions after it:

```tsx
  /**
   * The code is in (or the sign-in turned out already verified): go where
   * /me says. No code-required branch here on purpose, so a server that
   * disagrees with itself can never loop this page.
   */
  const finishSignIn = async (): Promise<void> => {
    try {
      await routeByPermissions(undefined);
    } catch {
      setVerifying(false);
      setStep('password');
      setStranded(true);
    }
  };

  /** Ask the API to email a code; show what it says. */
  const requestCode = async (token: string | undefined): Promise<void> => {
    setCodeError(null);
    setResending(true);
    try {
      const result = await sendLoginCode(token);
      if (result.verified) {
        await finishSignIn();
        return;
      }
      setPending(result);
      setNow(Date.now());
    } catch (caught) {
      setCodeError(loginCodeErrorMessage(caught));
    } finally {
      setResending(false);
    }
  };

  /** Password accepted (or a session arrived), but this sign-in still needs its code. */
  const enterCodeStep = async (token: string | undefined): Promise<void> => {
    setSubmitting(false);
    setError(null);
    setStranded(false);
    setCode('');
    setPending(null);
    setStep('code');
    await requestCode(token);
  };

  const handleVerify = async (): Promise<void> => {
    if (verifying || !isCompleteCode(code)) return;
    setVerifying(true);
    setCodeError(null);
    try {
      await verifyLoginCode(code);
    } catch (caught) {
      setCodeError(loginCodeErrorMessage(caught));
      setCode('');
      setVerifying(false);
      return;
    }
    // `verifying` stays true across the redirect, like `submitting` does.
    await finishSignIn();
  };

  const handleSwitchAccount = async (): Promise<void> => {
    await supabase.auth.signOut();
    setStep('password');
    setPending(null);
    setCode('');
    setCodeError(null);
    setPassword('');
    setVerifying(false);
    setSubmitting(false);
  };
```

Replace the body of `resolveDestination` with:

```tsx
  const resolveDestination = async (token: string | undefined): Promise<void> => {
    setStranded(false);
    try {
      await routeByPermissions(token);
    } catch (caught) {
      const failure = classifyMeFailure(caught);

      // The password was right; this sign-in just has not entered its emailed
      // code. NOT the sign-out branch below — that would throw away a good session.
      if (failure === 'code-required') {
        await enterCodeStep(token);
        return;
      }

      // A 401 here is not a blip — the session is genuinely unusable, so keep
      // the caller on the form rather than bouncing them into a shell that
      // will bounce them straight back. `admin/layout.tsx:46-59` documents
      // that loop; do not hand them a console link from here.
      if (failure === 'signed-out') {
        await supabase.auth.signOut();
        setSubmitting(false);
        setError('That session could not be verified. Please sign in again.');
        return;
      }

      // (keep the existing "EVERYTHING ELSE GETS ONE RETRY, AND THEN THE TRUTH." comment block here unchanged)
      try {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        await routeByPermissions(token);
      } catch (again) {
        if (classifyMeFailure(again) === 'code-required') {
          await enterCodeStep(token);
          return;
        }
        setSubmitting(false);
        setStranded(true);
      }
    }
  };
```

(The placeholder comment above only marks where the existing retry comment stays. Keep that comment's text exactly.)

After `handleSubmit`, add the mount check:

```tsx
  // ARRIVING WITH A SESSION THAT STILL NEEDS ITS CODE — a reload mid-step, a
  // deep link, or apiFetch / the console bouncing a LOGIN_CODE_REQUIRED here.
  // Go straight to the code step without asking for the password again. Any
  // other outcome leaves the password form exactly as it was; this effect
  // never signs anybody out.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (cancelled || !token) return;
      try {
        await apiFetch('/me', { headers: { Authorization: `Bearer ${token}` } });
      } catch (caught) {
        if (!cancelled && classifyMeFailure(caught) === 'code-required') {
          await enterCodeStep(token);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount only. enterCodeStep is re-created each render and only sets state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

In the JSX, make the heading and subtitle follow the step:

```tsx
            {step === 'code' ? 'CHECK YOUR EMAIL' : 'SIGN IN'}
```

```tsx
            {step === 'code'
              ? 'One more step: enter the code we just sent you.'
              : 'Manage your schedule, membership and payments.'}
```

Wrap the existing `<form onSubmit={handleSubmit} …> … </form>` in the code-step switch, so it becomes:

```tsx
          {step === 'code' ? (
            <LoginCodeStep
              sentTo={pending?.sentTo ?? null}
              code={code}
              error={codeError}
              verifying={verifying}
              resending={resending}
              resendSecondsLeft={secondsUntil(pending?.resendAvailableAt ?? null, now)}
              onCodeChange={setCode}
              onVerify={() => void handleVerify()}
              onResend={() => void requestCode(undefined)}
              onSwitchAccount={() => void handleSwitchAccount()}
            />
          ) : (
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {/* …the existing password form, unchanged… */}
            </form>
          )}
```

(Move the existing form's children unchanged into the `<form>` above. The `{/* …the existing password form, unchanged… */}` line stands for those exact children and must not be committed.)

`ApiError` is dropped from the `@/lib/api` import above: once `resolveDestination` uses `classifyMeFailure`, `LoginPage` no longer references it.

- [ ] **Step 6: Run the client suite and typecheck**

Run: `npm test --workspace=client`
Expected: PASS.

Run: `npm run build --workspace=shared && npm run typecheck --workspace=client`
Expected: exit 0. If it fails only on `LayoutProps` / `.next/types`, that is the known rough edge. Run `npm run build --workspace=client` first, then the typecheck again.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/auth/LoginCodeStep.tsx client/src/components/auth/LoginCodeStep.test.tsx client/src/components/auth/LoginPage.tsx
git commit -m "feat(login-code): login page asks for the emailed code after the password

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs, then the production-readiness gate

**Files:**
- Modify: `CLAUDE.md` (the "Auth & RBAC" bullet list, after "Phase 5 — check-in.")
- Modify: `docs/deploy.md` (the "Operational" env table, after the `GYM_VAT_REGISTERED` row)

**Interfaces:**
- Consumes: everything above. Produces nothing new.

- [ ] **Step 1: Document the gate and the kill switch**

In `CLAUDE.md`, after `- **Phase 5 — check-in.** QR-based member check-in.`:

```markdown
- **Sign-in code (2026-10-15).** After the password, every sign-in enters a 6-digit code our API emails through Resend (`docs/superpowers/specs/2026-10-15-login-code-design.md`). `LoginGateService` is the one decision point — `AuthGuard` and `StationTokenAccessGuard`'s staff path both call it — and an unverified sign-in gets `401 LOGIN_CODE_REQUIRED` everywhere except the two `@AllowUnverifiedLogin()` routes under `/auth/login-code`. Verified means a `LoginVerification` row with `verifiedAt` for the token's `session_id`, or an email-link `amr` (`otp`, `magiclink`, `invite`, `recovery`), or `LOGIN_CODE_REQUIRED=false`. That env var is the **kill switch** when email breaks: set it `false` and restart. Live chat applies the same rule in SQL (`public.login_session_verified()` in the Realtime policy), reading the switch from the one-row `LoginCodeSetting` the API writes at boot. A token without `session_id` is refused. The e2e harness defaults the switch to `false` (`test/support/db.ts`).
```

In `docs/deploy.md`, add a row after the `GYM_VAT_REGISTERED` row of the operational table:

```markdown
| `LOGIN_CODE_REQUIRED` | `true`          | Every sign-in must enter an emailed 6-digit code. **Needs `RESEND_API_KEY` and `RESEND_FROM` set first** — with them missing nobody can finish signing in (the boot log says so). If email breaks, set `false` and restart: everyone signs in with the password alone until it is fixed. |
```

- [ ] **Step 2: Run the production-readiness gate (CLAUDE.md order: clean → build → typecheck → test)**

Stop any `next dev` / `nest start --watch` first. Then run:

```bash
rm -rf client/.next shared/dist server/dist server/tsconfig.build.tsbuildinfo
npm run build --workspace=shared
DATABASE_URL="postgresql://x:x@localhost:5432/x" DIRECT_URL="postgresql://x:x@localhost:5432/x" npm run prisma:generate --workspace=server
npm run build --workspace=server
ls server/dist/main.js
npm run build --workspace=client
npm run check:tailwind --workspace=client
npm run typecheck --workspace=server
npm run typecheck --workspace=client
npm test --workspace=server
npm test --workspace=client
```

Expected: every command exits 0. `server/dist/main.js` exists. `check:tailwind` reports a non-zero utility count. Do NOT run `npm run lint` or `npm run test:e2e`.

- [ ] **Step 3: Manual lint, only on the files this branch touched**

Run: `npx eslint --no-fix $(git diff --name-only main...HEAD -- '*.ts' '*.tsx')` from the repo root.
Expected: no errors in those files. Fix any error by hand. Never commit a `--fix` edit to an unrelated file.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/deploy.md
git commit -m "docs(login-code): the sign-in code gate and its kill switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand the owner the manual pre-merge checks from the spec**

Report these (not automated):
1. Decode a real access token from each environment's Supabase and confirm `session_id` is present.
2. Confirm the `amr` methods for a password, a magic-link (`/join`), an invite and a recovery sign-in on that project. If a magic link reports something other than `otp`/`magiclink`, update `EMAIL_LINK_AMR_METHODS` **and** the migration's list together.
3. Resend verified and `RESEND_API_KEY`/`RESEND_FROM` set on the API host before merging. Merge outside opening hours: every signed-in device asks for one code.
4. Run the batched e2e, including `test/login-code-constraints.e2e-spec.ts`.
5. On Supabase, confirm migration 2 did not print the `insufficient privilege` warning. If it did, run its function and policy in the SQL editor.
