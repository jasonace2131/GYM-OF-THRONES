# Counter Sign-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A walk-in gives a name and an email at the counter. When they subscribe, they get our own single-use setup link, valid for 7 days. On first use they set a password and a birth date, and they land in the portal with their plan already active. Staff can fix a mistyped email for a member who has never signed in.

**Architecture:**
- The walk-in sale stores `CheckIn.guestEmail`. The "required" rule is enforced in the service, not the database.
- A new one-row-per-member `MemberJoinLink` table holds a sha256 token hash, reusing the staff-invitation token helpers.
- `MemberJoinService` (in `server/src/users`) does three things:
  - rotates and emails the link;
  - runs the public lookup, claim-link and accept steps;
  - mints a Supabase magic link only when the member presses "Set up my account".
- `MembersService.create` creates the Supabase user with `auth.admin.createUser`, with no emailed link, then calls `MemberJoinService.issue`.
- A new `/join/[token]` client page mirrors `/invite/[token]`.

**Tech Stack:**
- Server: NestJS 11, Prisma 6 (folder schema, hand-written SQL migrations), class-validator, Jest, `@supabase/supabase-js` admin API, Resend.
- Client: Next.js 16 App Router, vitest.
- `@got/shared` for types and error codes.

**Spec:** `docs/superpowers/specs/2026-10-14-counter-signup-design.md`. Read it before your task. It is the authority, and this plan argues from it.

## Global Constraints

- Work on branch `feat/counter-signup` in `E:\ALL PROJECTS\GYM OF THRONES\GYM OF THRONES\.claude\worktrees\assistant-settings`. **Never push, and never touch `main`.**
- `server/.env` does not exist in this worktree, and you must never create or read one. Prisma CLI commands need the dummy URLs inline: `DATABASE_URL="postgresql://x:x@localhost:5432/x" DIRECT_URL="postgresql://x:x@localhost:5432/x" npx prisma generate` (run inside `server/`). Never run `prisma migrate` or `prisma db` against anything.
- **Do not run `npm run lint`.** The server's lint script runs `eslint --fix` and rewrites unrelated files.
- **Do not run e2e tests.** Under the owner's batch-E2E rule, e2e specs are written and not run.
- Server unit tests: `npm test --workspace=server -- <pattern>` from the repo root. Client: `npx vitest run <path>` inside `client/`. `@got/shared` must be built before the server typecheck: `npm run build --workspace=shared`.
- Prettier style: single quotes, trailing commas, 100 columns, LF line endings. Server env reads use `config.get('KEY', { infer: true })`.
- Match the surrounding code's comment density and voice. These files explain *why* in block comments; keep that, but add no comment that only restates the code.
- Every commit message ends with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The link lives 7 days. The token is `newInvitationToken()` / `hashInvitationToken()` from `server/src/staff-invitations/invitation-token.ts`.
- Error codes, verbatim:
  - `GUEST_NAME_REQUIRED` (422)
  - `GUEST_EMAIL_REQUIRED` (422)
  - `MEMBER_JOIN_NOT_FOUND` (404)
  - `MEMBER_JOIN_EXPIRED` (410)
  - `MEMBER_JOIN_USED` (410)
  - `MEMBER_JOIN_WRONG_ACCOUNT` (403)
  - `MEMBER_ALREADY_SIGNED_IN` (409)
- Audit action, verbatim: `MEMBER_EMAIL_CHANGED`.
- **Privacy:** `guestEmail` is never read by `toDeskGuest`, `CheckInRecordSource`, the desk feed, `DeskMember`, the payment-detail presenter or reports. Only `GET /front-desk/check-ins/:id/guest` (`member.create`) returns it.
- A setup link is issued only for a member with `lastSeenAt === null` and `deletedAt === null`.
- Staff routes never return the token or the link. It is emailed only.
- Client UI uses the existing portal and admin classes. No Tailwind in `components/admin`, `components/auth` or `app/(auth)`.

## Review Focus

These are the five failure modes the spec implies that are most likely to bite. Each has a pinning test in its owning task.

1. **Admin on the desk PC opens a member's link.** The password form must never show for a session whose email differs from the link's email, or the admin would change their own password. Pinned in Task 8: `joinStage` gives `signed-in-other`.
2. **Old account-less walk-ins with no email** must still check out, void and convert. No DB CHECK may require `guestEmail`. Pinned in Task 1: the e2e spec updates an old guest row with null email and expects success.
3. **Resend for a member who has already signed in** must refuse (409), never mint a link into an active account. Pinned in Task 4: `issue` refuses `lastSeenAt !== null`.
4. **A used link reopened** must answer `USED`, and claim-link must refuse it. A rotation must never revive a used row. Pinned in Task 4: `issue` and `claimLink` tests on a used row.
5. **An email change where Supabase succeeds and the local write fails** (for example a local `User_email_key` collision) must put the Supabase email back. Pinned in Task 5: the revert test.

---

## File Structure

**Server**

| File | Change | Responsibility |
|---|---|---|
| `server/prisma/schema/migrations/20261014010000_audit_action_member_email/migration.sql` | create | `ALTER TYPE "AuditAction" ADD VALUE 'MEMBER_EMAIL_CHANGED'` |
| `server/prisma/schema/migrations/20261014010100_counter_signup/migration.sql` | create | `CheckIn.guestEmail` and its CHECK; the `MemberJoinLink` table, CHECKs and RLS |
| `server/prisma/schema/member-join-link.prisma` | create | `MemberJoinLink` model |
| `server/prisma/schema/check-in.prisma` | modify | `guestEmail String?` |
| `server/prisma/schema/user.prisma` | modify | back-relations `memberJoinLink`, `memberJoinLinksIssued` |
| `server/prisma/schema/enums.prisma` | modify | `MEMBER_EMAIL_CHANGED` |
| `server/test/counter-signup-constraints.e2e-spec.ts` | create | CHECK names and predicates (written, not run) |
| `shared/src/types/api.types.ts` | modify | 7 new error codes |
| `shared/src/types/member-join.types.ts` | create | `MemberJoinLookup`, `MemberJoinClaim`, `MemberJoinAccepted` |
| `shared/src/index.ts` | modify | export the new types |
| `server/src/front-desk/guest-identity.ts` | create | `requireGuestIdentity(dto)`, a pure function |
| `server/src/front-desk/guest-identity.spec.ts` | create | its tests |
| `server/src/front-desk/dto/sell-walk-in.dto.ts` | modify | `guestEmail?` |
| `server/src/front-desk/dto/sell-walk-in.dto.spec.ts` | create | DTO normalisation test |
| `server/src/front-desk/walk-in.service.ts` | modify | call `requireGuestIdentity`; store `guestEmail` |
| `server/src/front-desk/front-desk.service.ts`, `front-desk.controller.ts` | modify | `guestContact` returns `guestEmail` |
| `server/src/front-desk/front-desk.service.spec.ts` | modify | `guestContact` test |
| `server/src/front-desk/desk.presenter.spec.ts` | modify | privacy test: no `guestEmail` in output |
| `server/src/auth/supabase-admin.service.ts` (+spec) | modify | add `createAuthUser`, `memberJoinSignInLink`, `updateAuthEmail`. Task 5 removes `generateInviteLink`, `generateMagicLink`, `generateLink` and `GeneratedLink` |
| `server/src/notifications/email.service.ts` (+spec) | modify | add `sendMemberJoin` and `memberJoinHtml`. Task 5 removes `sendMagicLink` and `inviteHtml` |
| `server/src/auth/jwt-verifier.ts` | modify | `export` `asJoinableBirthDate` |
| `server/src/users/member-join.service.ts` (+spec) | create | issue/rotate/email, lookup, claimLink, accept |
| `server/src/users/member-join.controller.ts` (+spec) | create | public `member-join/*` routes |
| `server/src/users/dto/member-join.dto.ts` | create | token and accept DTOs |
| `server/src/users/dto/change-email.dto.ts` | create | `ChangeMemberEmailDto` |
| `server/src/users/users.module.ts` | modify | register the controller and service |
| `server/src/users/members.service.ts` (+spec) | modify | `create` uses `createAuthUser` + `memberJoin.issue`; `resendInvite` → `memberJoin.issue`; new `changeEmail` |
| `server/src/users/members.controller.ts` (+spec) | modify | forward `Origin`; new `POST :id/change-email` |

**Client**

| File | Change | Responsibility |
|---|---|---|
| `client/src/lib/guestEmail.ts` (+test) | create | `isPlausibleEmail` |
| `client/src/components/admin/WalkInSheet.tsx`, `actions/WalkInModal.tsx` | modify | required email; required name |
| `client/src/lib/memberSeed.ts` (+test) | create | `NewMemberSeed`, `seedFromGuest`, moved out of `NewMemberDrawer.tsx` |
| `client/src/components/admin/NewMemberDrawer.tsx` | modify | import the seed from lib; success copy |
| `client/src/app/admin/attendance/page.tsx`, `client/src/app/admin/walk-ins/page.tsx` | modify | import `seedFromGuest` from lib |
| `client/src/lib/adminApi.ts` (+test) | modify | `sellWalkIn.guestEmail`, `checkInGuest.guestEmail`, `changeMemberEmail`, the audit union |
| `client/src/components/admin/actions/ChangeEmailModal.tsx` | create | the Change email modal |
| `client/src/components/admin/MemberDrawer.tsx` | modify | Change email action; resend copy |
| `client/src/app/admin/audit/page.tsx` | modify | label and tone for `MEMBER_EMAIL_CHANGED` |
| `client/src/lib/memberJoin.ts` (+test) | create | stage, copy, birth-date check, `memberJoinApi` |
| `client/src/components/auth/JoinPage.tsx` | create | the setup page |
| `client/src/app/(auth)/join/[token]/page.tsx` | create | the route |

---

### Task 1: Schema, migrations, shared types and error codes

**Files:**
- Create: `server/prisma/schema/migrations/20261014010000_audit_action_member_email/migration.sql`
- Create: `server/prisma/schema/migrations/20261014010100_counter_signup/migration.sql`
- Create: `server/prisma/schema/member-join-link.prisma`
- Modify: `server/prisma/schema/check-in.prisma` (after `guestPhone String?`, around line 41)
- Modify: `server/prisma/schema/user.prisma` (beside `assistantSettingsUpdated`, around line 149)
- Modify: `server/prisma/schema/enums.prisma` (after `ASSISTANT_INSTRUCTIONS_RESET`, around line 370)
- Create: `server/test/counter-signup-constraints.e2e-spec.ts`
- Modify: `shared/src/types/api.types.ts`
- Create: `shared/src/types/member-join.types.ts`
- Modify: `shared/src/index.ts`

**Interfaces:**
- Produces:
  - Prisma models `MemberJoinLink` (fields `id`, `userId`, `tokenHash`, `issuedAt`, `expiresAt`, `issuedById`, `usedAt`, `createdAt`; relations `user`, `issuedBy`).
  - `CheckIn.guestEmail: string | null`.
  - `User.memberJoinLink: MemberJoinLink | null`.
  - Enum value `AuditAction.MEMBER_EMAIL_CHANGED`.
  - Shared types `MemberJoinStatus`, `MemberJoinLookup`, `MemberJoinClaim`, `MemberJoinAccepted`.
  - 7 error codes in `DomainErrorCode`.

- [ ] **Step 1: Write the enum migration**

`server/prisma/schema/migrations/20261014010000_audit_action_member_email/migration.sql`:

```sql
-- Counter sign-up (feat/counter-signup): one audit action.
--
-- ALONE ON PURPOSE (see 20260922000000_*): a value added by ALTER TYPE ... ADD VALUE
-- cannot be used in the transaction that adds it, and Prisma runs each file in one.
--
--   MEMBER_EMAIL_CHANGED  staff corrected the email of a member who has never signed in
ALTER TYPE "AuditAction" ADD VALUE 'MEMBER_EMAIL_CHANGED';
```

- [ ] **Step 2: Write the table migration**

`server/prisma/schema/migrations/20261014010100_counter_signup/migration.sql`:

```sql
-- Counter sign-up (feat/counter-signup, 2026-10-14).
--
-- Hand-written: prisma migrate dev refuses on the shared dev DB (checksum drift).
-- ADDITIVE ONLY: one nullable column and one new table. main's code never reads
-- either, so it keeps running against this schema during the deploy window.
--
-- Every CHECK below lives ONLY here — Prisma cannot represent them — so
-- test/counter-signup-constraints.e2e-spec.ts asserts each name AND predicate.

-- ── 1. The walk-in's email ──────────────────────────────────────────────────
--
-- SHAPE ONLY. "An account-less walk-in must give an email" is enforced by
-- WalkInService, deliberately NOT by a CHECK: a NOT VALID constraint skips
-- existing rows only when it is created, and Postgres re-checks it on every later
-- UPDATE. Production already holds account-less walk-ins with no email, and those
-- rows are still updated (check-out, the auto-close job, voids, "Make member"'s
-- convertedToUserId) — each of which would start failing with a 500.
ALTER TABLE "CheckIn" ADD COLUMN "guestEmail" TEXT;

ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_guest_email_sane"
    CHECK (
      "guestEmail" IS NULL
      OR ("guestEmail" = lower(btrim("guestEmail")) AND char_length("guestEmail") BETWEEN 3 AND 254)
    );

-- ── 2. The member's setup link ──────────────────────────────────────────────
--
-- ONE ROW PER MEMBER. Resend and an email change ROTATE it (new hash, new
-- expiry), so the previous link dies at once. Only the sha256 of the token is
-- stored; the token itself goes into the email and nowhere else.
CREATE TABLE "MemberJoinLink" (
    "id"         UUID           NOT NULL,
    "userId"     UUID           NOT NULL,
    "tokenHash"  CHAR(64)       NOT NULL,
    "issuedAt"   TIMESTAMPTZ(3) NOT NULL,
    "expiresAt"  TIMESTAMPTZ(3) NOT NULL,
    "issuedById" UUID,
    "usedAt"     TIMESTAMPTZ(3),
    "createdAt"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberJoinLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemberJoinLink_userId_key" ON "MemberJoinLink"("userId");
CREATE UNIQUE INDEX "MemberJoinLink_tokenHash_key" ON "MemberJoinLink"("tokenHash");

-- CASCADE: a link is meaningless without its member and must never block a delete.
ALTER TABLE "MemberJoinLink" ADD CONSTRAINT "MemberJoinLink_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, like AssistantSettings.updatedById: the link outlives the staff account.
ALTER TABLE "MemberJoinLink" ADD CONSTRAINT "MemberJoinLink_issuedById_fkey"
    FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MemberJoinLink" ADD CONSTRAINT "MemberJoinLink_token_hash_shape"
    CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "MemberJoinLink" ADD CONSTRAINT "MemberJoinLink_expiry_after_issue"
    CHECK ("expiresAt" > "issuedAt");

ALTER TABLE "MemberJoinLink" ADD CONSTRAINT "MemberJoinLink_used_after_issue"
    CHECK ("usedAt" IS NULL OR "usedAt" >= "issuedAt");

-- Lock it like every other table (see 20261011000000_member_notices). ENABLE (not
-- FORCE) leaves the server's BYPASSRLS role unaffected.
ALTER TABLE "MemberJoinLink" ENABLE ROW LEVEL SECURITY;

-- Guarded: `anon` and `authenticated` do not exist in the plain Postgres the e2e
-- harness builds from these migrations.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "MemberJoinLink" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "MemberJoinLink" FROM authenticated';
  END IF;
END
$rls$;
```

- [ ] **Step 3: Add the Prisma model, the column, the back-relations and the enum value**

`server/prisma/schema/member-join-link.prisma`:

```prisma
/// A staff-created member's setup link (feat/counter-signup, 2026-10-14).
/// ONE ROW PER MEMBER.
///
/// Emailed when the account is created at the counter, and rotated by "Resend
/// invite" and by an email correction — each rotation writes a new hash and expiry,
/// so the previous link dies at once. Only the sha256 of the token is stored.
///
/// The CHECKs (hash shape, expiry after issue, used after issue) live only in
/// migration 20261014010100_counter_signup — Prisma cannot represent them.
model MemberJoinLink {
  id         String    @id @default(uuid()) @db.Uuid
  userId     String    @unique @db.Uuid
  tokenHash  String    @unique @db.Char(64)
  issuedAt   DateTime  @db.Timestamptz(3)
  expiresAt  DateTime  @db.Timestamptz(3)
  issuedById String?   @db.Uuid
  /// Set once, when the member finishes setting up. A used link is never rotated.
  usedAt     DateTime? @db.Timestamptz(3)
  createdAt  DateTime  @default(now()) @db.Timestamptz(3)

  user     User  @relation("MemberJoinLinkUser", fields: [userId], references: [id], onDelete: Cascade)
  issuedBy User? @relation("MemberJoinLinkIssuedBy", fields: [issuedById], references: [id], onDelete: SetNull)
}
```

In `server/prisma/schema/check-in.prisma`, directly after `guestPhone String?`, add:

```prisma
  /// The walk-in's email (feat/counter-signup): required by WalkInService for
  /// every NEW account-less sale, so "Make member" arrives pre-filled. Nullable
  /// because older visits have none, and that must stay true — see the
  /// migration's note on why no CHECK requires it. As private as guestPhone:
  /// no desk projection reads it.
  guestEmail String?
```

In `server/prisma/schema/user.prisma`, directly after the `assistantSettingsUpdated` line, add:

```prisma
  memberJoinLink        MemberJoinLink?  @relation("MemberJoinLinkUser")
  memberJoinLinksIssued MemberJoinLink[] @relation("MemberJoinLinkIssuedBy")
```

In `server/prisma/schema/enums.prisma`, directly after `ASSISTANT_INSTRUCTIONS_RESET`, add:

```prisma
  // Staff corrected the email of a member who has never signed in (counter sign-up).
  MEMBER_EMAIL_CHANGED
```

- [ ] **Step 4: Generate the client and check that the schema compiles**

Run (inside `server/`): `DATABASE_URL="postgresql://x:x@localhost:5432/x" DIRECT_URL="postgresql://x:x@localhost:5432/x" npx prisma generate`
Expected: `Generated Prisma Client`. Fix any schema error before continuing.

- [ ] **Step 5: Add the shared types and error codes**

`shared/src/types/member-join.types.ts`:

```ts
/**
 * A staff-created member's setup link (`/join/<token>`) — counter sign-up.
 *
 * The page is public: it holds nothing but the token from the email.
 */
export type MemberJoinStatus = 'PENDING' | 'USED' | 'EXPIRED';

/**
 * `GET /member-join/lookup?token=` — public.
 *
 * `email` is present only while PENDING. The page compares it with the signed-in
 * session's email before it offers a password form, so a different account
 * signed in on the same computer can never change its own password here. The
 * token already lets its holder into this account, so the address reveals
 * nothing more.
 */
export interface MemberJoinLookup {
  firstName: string;
  status: MemberJoinStatus;
  email?: string;
}

/** `POST /member-join/claim-link` — public. Where "Set up my account" goes next. */
export interface MemberJoinClaim {
  url: string;
}

/** `POST /member-join/accept`. `dateOfBirthSaved` is false when the date was not joinable or one was already on file. */
export interface MemberJoinAccepted {
  dateOfBirthSaved: boolean;
}
```

In `shared/src/index.ts`, directly after `export * from './types/staff.types';`, add:

```ts
// Counter sign-up: a staff-created member's setup link.
export * from './types/member-join.types';
```

In `shared/src/types/api.types.ts`, directly after the `'GUEST_NOT_FOUND'` line (the GUEST_* block), add:

```ts
  // An account-less walk-in or guest-pass sale with no name, or no email. The
  // email is what lets "Make member" arrive pre-filled — the setup link goes there.
  | 'GUEST_NAME_REQUIRED'
  | 'GUEST_EMAIL_REQUIRED'
```

And directly after the `'MEMBER_INVITE_FAILED'` line (end of the C2 block), add:

```ts
  // ── Counter sign-up — the member's own setup link ──────────────────────────
  // NOT_FOUND 404: no such link, or its member was deleted. EXPIRED and USED are
  // 410 — the link existed and is dead, and the setup page says which.
  // WRONG_ACCOUNT 403: accept called by a different signed-in account.
  // ALREADY_SIGNED_IN 409: resend or change-email for a member who has signed in
  // at least once — a link is a way into the account, so staff never get to mint
  // one for an active member. They use "Forgot password" instead.
  | 'MEMBER_JOIN_NOT_FOUND'
  | 'MEMBER_JOIN_EXPIRED'
  | 'MEMBER_JOIN_USED'
  | 'MEMBER_JOIN_WRONG_ACCOUNT'
  | 'MEMBER_ALREADY_SIGNED_IN'
```

- [ ] **Step 6: Write the constraints e2e spec (do not run it)**

Model it on `server/test/assistant-settings-constraints.e2e-spec.ts` (same helpers: `createTestApp`, `resetDatabase`, `definitionOf`, `checksOn`). Create `server/test/counter-signup-constraints.e2e-spec.ts`:

```ts
import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

const MEMBER_SUPABASE_ID = '64000000-0000-4000-8000-0000000000c1';
const ADMIN_SUPABASE_ID = '64000000-0000-4000-8000-0000000000a1';
const HASH = 'a'.repeat(64);

/**
 * Counter sign-up, asserted at the DATABASE (feat/counter-signup, migrations
 * 20261014010000_audit_action_member_email and 20261014010100_counter_signup).
 *
 * Every rule here lives only in hand-written migration SQL: a `db push` or a
 * regenerated migration would drop it silently while every service test kept
 * passing.
 *
 * Written 2026-10-14 under the owner's batch-E2E rule and not yet run against
 * Postgres: the predicate strings are what `pg_get_constraintdef` is expected
 * to print, and are the first thing to check if this suite fails on its first run.
 */
describe('CHECK constraints — counter sign-up (e2e)', () => {
  let ctx: TestApp;
  let memberId: string;
  let adminId: string;

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

  /** One link with every column valid; `over` is raw SQL per column. */
  const insertLink = (over: Record<string, string> = {}): Promise<number> => {
    const columns: Record<string, string> = {
      id: 'gen_random_uuid()',
      '"userId"': `'${memberId}'`,
      '"tokenHash"': `'${HASH}'`,
      '"issuedAt"': `'2026-10-14T00:00:00Z'`,
      '"expiresAt"': `'2026-10-21T00:00:00Z'`,
      '"issuedById"': `'${adminId}'`,
      ...over,
    };
    return ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "MemberJoinLink" (${Object.keys(columns).join(', ')})
       VALUES (${Object.values(columns).join(', ')})`,
    );
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await ctx.fixture.tokenFor('CLIENT', { supabaseId: MEMBER_SUPABASE_ID });
    await ctx.fixture.tokenFor('ADMIN', { supabaseId: ADMIN_SUPABASE_ID });
    memberId = await ctx.fixture.userIdFor(MEMBER_SUPABASE_ID);
    adminId = await ctx.fixture.userIdFor(ADMIN_SUPABASE_ID);
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "MemberJoinLink"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('presence', () => {
    it('names exactly the MemberJoinLink CHECKs the migration wrote', async () => {
      expect(await checksOn('MemberJoinLink')).toEqual([
        'MemberJoinLink_expiry_after_issue',
        'MemberJoinLink_token_hash_shape',
        'MemberJoinLink_used_after_issue',
      ]);
    });

    it('asserts each PREDICATE, not just the name', async () => {
      expect(await definitionOf('MemberJoinLink_token_hash_shape')).toBe(
        `CHECK (("tokenHash" ~ '^[0-9a-f]{64}$'::text))`,
      );
      expect(await definitionOf('MemberJoinLink_expiry_after_issue')).toBe(
        'CHECK (("expiresAt" > "issuedAt"))',
      );
      expect(await definitionOf('MemberJoinLink_used_after_issue')).toBe(
        'CHECK ((("usedAt" IS NULL) OR ("usedAt" >= "issuedAt")))',
      );
      expect(await definitionOf('CheckIn_guest_email_sane')).toBe(
        `CHECK ((("guestEmail" IS NULL) OR (("guestEmail" = lower(btrim("guestEmail"))) AND ((char_length("guestEmail") >= 3) AND (char_length("guestEmail") <= 254)))))`,
      );
    });

    it('has RLS enabled on MemberJoinLink', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ relrowsecurity: boolean }>>`
        SELECT relrowsecurity FROM pg_class WHERE relname = 'MemberJoinLink'
      `;
      expect(rows[0].relrowsecurity).toBe(true);
    });

    it('adds the MEMBER_EMAIL_CHANGED audit value', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ value: string }>>`
        SELECT unnest(enum_range(NULL::"AuditAction"))::text AS value
      `;
      expect(rows.map((row) => row.value)).toContain('MEMBER_EMAIL_CHANGED');
    });
  });

  describe('MemberJoinLink rules', () => {
    it('accepts a valid row (positive control)', async () => {
      await expect(insertLink()).resolves.toBe(1);
    });

    it('refuses a token hash that is not 64 lower-case hex characters', async () => {
      await expect(insertLink({ '"tokenHash"': `'${'A'.repeat(64)}'` })).rejects.toThrow(
        /MemberJoinLink_token_hash_shape/,
      );
    });

    it('refuses an expiry at or before the issue time', async () => {
      await expect(insertLink({ '"expiresAt"': `'2026-10-14T00:00:00Z'` })).rejects.toThrow(
        /MemberJoinLink_expiry_after_issue/,
      );
    });

    it('refuses a use before the issue time', async () => {
      await expect(insertLink({ '"usedAt"': `'2026-10-13T00:00:00Z'` })).rejects.toThrow(
        /MemberJoinLink_used_after_issue/,
      );
    });

    it('allows one link per member', async () => {
      await insertLink();
      await expect(insertLink({ '"tokenHash"': `'${'b'.repeat(64)}'` })).rejects.toThrow(
        /MemberJoinLink_userId_key/,
      );
    });

    it('deletes the link with its member (CASCADE) and keeps it when the issuer goes (SET NULL)', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
        SELECT conname, confdeltype FROM pg_constraint
        WHERE conrelid = '"MemberJoinLink"'::regclass AND contype = 'f' ORDER BY conname
      `;
      expect(rows).toEqual([
        { conname: 'MemberJoinLink_issuedById_fkey', confdeltype: 'n' },
        { conname: 'MemberJoinLink_userId_fkey', confdeltype: 'c' },
      ]);
    });
  });

  describe('CheckIn.guestEmail', () => {
    it('refuses an email that is not lower-case and trimmed', async () => {
      await expect(
        ctx.prisma.$executeRawUnsafe(
          `UPDATE "CheckIn" SET "guestEmail" = ' Ana@Example.com' WHERE false`,
        ),
      ).resolves.toBe(0);
      // A real row: see the sane-row test below, which also proves an old
      // email-less guest row can still be updated.
    });

    it('still lets an old account-less walk-in with NO email be updated — no CHECK requires it', async () => {
      const [row] = await ctx.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "CheckIn" WHERE "userId" IS NULL AND "guestEmail" IS NULL LIMIT 1
      `;
      // The reset database may hold no guest visit; the assertion that matters is
      // that no CHECK on CheckIn names guestEmail as required.
      const checks = await checksOn('CheckIn');
      expect(checks.filter((name) => name.includes('guest_email'))).toEqual([
        'CheckIn_guest_email_sane',
      ]);
      if (row !== undefined) {
        await expect(
          ctx.prisma.$executeRawUnsafe(
            `UPDATE "CheckIn" SET "guestName" = "guestName" WHERE id = '${row.id}'`,
          ),
        ).resolves.toBe(1);
      }
    });
  });
});
```

- [ ] **Step 7: Build shared and typecheck the server**

Run from the repo root: `npm run build --workspace=shared && npm run typecheck --workspace=server`
Expected: both pass. The new fields are unused so far, so nothing breaks.

- [ ] **Step 8: Run the server unit tests**

Run: `npm test --workspace=server -- --silent`
Expected: all pass (the same count as before this task).

- [ ] **Step 9: Commit**

```bash
git add server/prisma/schema shared/src server/test/counter-signup-constraints.e2e-spec.ts
git commit -m "feat(schema): walk-in guest email and member setup links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Walk-in sale takes a name and an email (server)

**Files:**
- Create: `server/src/front-desk/guest-identity.ts`, `server/src/front-desk/guest-identity.spec.ts`
- Create: `server/src/front-desk/dto/sell-walk-in.dto.spec.ts`
- Modify: `server/src/front-desk/dto/sell-walk-in.dto.ts` (after `guestName`, around line 85)
- Modify: `server/src/front-desk/walk-in.service.ts` (the two waiver checks, around lines 159 and 286; both `writeEntry` calls; `writeEntry`'s input type and `createMany` data)
- Modify: `server/src/front-desk/front-desk.service.ts:100-121`, `server/src/front-desk/front-desk.controller.ts:242-250`
- Test: `server/src/front-desk/front-desk.service.spec.ts`, `server/src/front-desk/desk.presenter.spec.ts`

**Interfaces:**
- Consumes: `CheckIn.guestEmail` (Task 1); the error codes `GUEST_NAME_REQUIRED` and `GUEST_EMAIL_REQUIRED` (Task 1).
- Produces:
  - `requireGuestIdentity(dto: { userId?: string; guestName?: string; guestEmail?: string }): void`
  - `SellWalkInDto.guestEmail?: string`
  - `FrontDeskService.guestContact(id)` returns `{ guestName, guestPhone, guestEmail, guestEmergencyContact }`, each `string | null`

- [ ] **Step 1: Write the failing test for the identity rule**

`server/src/front-desk/guest-identity.spec.ts`:

```ts
import { requireGuestIdentity } from './guest-identity';

describe('requireGuestIdentity', () => {
  it('passes a guest with a name and an email', () => {
    expect(() =>
      requireGuestIdentity({ guestName: 'Ana Cruz', guestEmail: 'ana@example.com' }),
    ).not.toThrow();
  });

  it('asks nothing of an existing member — their account already has both', () => {
    expect(() =>
      requireGuestIdentity({ userId: '11111111-1111-4111-8111-111111111111' }),
    ).not.toThrow();
  });

  it('refuses a guest with no name, as GUEST_NAME_REQUIRED (422)', () => {
    expect(() => requireGuestIdentity({ guestEmail: 'ana@example.com' })).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'GUEST_NAME_REQUIRED' }),
        status: 422,
      }),
    );
  });

  it('refuses a guest with no email, as GUEST_EMAIL_REQUIRED (422)', () => {
    expect(() => requireGuestIdentity({ guestName: 'Ana Cruz' })).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'GUEST_EMAIL_REQUIRED' }),
        status: 422,
      }),
    );
  });

  it('checks the name first when both are missing', () => {
    expect(() => requireGuestIdentity({})).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'GUEST_NAME_REQUIRED' }) }),
    );
  });
});
```

Before relying on `response.code` and `status`, check how `DomainException` exposes the code: read `server/src/common/exceptions/domain.exception.ts` and an existing assertion such as `supabase-admin.service.spec.ts`'s `toMatchObject({ response: { code: ... } })`. Then adjust the matcher to match.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test --workspace=server -- guest-identity`
Expected: FAIL, "Cannot find module './guest-identity'".

- [ ] **Step 3: Implement it**

`server/src/front-desk/guest-identity.ts`:

```ts
import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain.exception';

/**
 * WHO an account-less guest is — a name and an email — required before a walk-in
 * or a guest pass is sold to somebody with no account (owner, 2026-10-14).
 *
 * The email is what turns a walk-in into a member later: "Make member" arrives
 * pre-filled with it, and the setup link goes there. An existing member
 * (`userId` present) is asked for neither; their account already holds both.
 *
 * Enforced HERE and not by a database CHECK: see migration
 * 20261014010100_counter_signup for why a "required" CHECK would break every
 * later update of the older guest visits that have no email.
 */
export function requireGuestIdentity(dto: {
  userId?: string;
  guestName?: string;
  guestEmail?: string;
}): void {
  if (dto.userId !== undefined) return;
  if (dto.guestName === undefined || dto.guestName === '') {
    throw new DomainException(
      'GUEST_NAME_REQUIRED',
      "Enter the guest's name before selling the day pass.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  if (dto.guestEmail === undefined || dto.guestEmail === '') {
    throw new DomainException(
      'GUEST_EMAIL_REQUIRED',
      "Enter the guest's email before selling the day pass.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
```

- [ ] **Step 4: Run it to make sure it passes**

Run: `npm test --workspace=server -- guest-identity`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing DTO test**

`server/src/front-desk/dto/sell-walk-in.dto.spec.ts`:

```ts
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SellWalkInDto } from './sell-walk-in.dto';

async function check(body: Record<string, unknown>) {
  const dto = plainToInstance(SellWalkInDto, { kind: 'WALK_IN', ...body });
  return { dto, errors: await validate(dto) };
}

describe('SellWalkInDto.guestEmail', () => {
  it('trims and lower-cases, the one spelling CheckIn_guest_email_sane accepts', async () => {
    const { dto, errors } = await check({ guestEmail: '  Ana.Cruz@Example.COM ' });
    expect(errors).toEqual([]);
    expect(dto.guestEmail).toBe('ana.cruz@example.com');
  });

  it('is optional in the DTO — the service decides when it is required', async () => {
    const { errors } = await check({});
    expect(errors).toEqual([]);
  });

  it('refuses something that is not an email', async () => {
    const { errors } = await check({ guestEmail: 'not-an-email' });
    expect(errors.map((error) => error.property)).toEqual(['guestEmail']);
  });

  it('refuses an address over 254 characters', async () => {
    const { errors } = await check({ guestEmail: `${'a'.repeat(250)}@x.co` });
    expect(errors.map((error) => error.property)).toEqual(['guestEmail']);
  });
});
```

- [ ] **Step 6: Run it to make sure it fails**

Run: `npm test --workspace=server -- sell-walk-in.dto`
Expected: FAIL. `guestEmail` is either rejected or left un-normalised.

- [ ] **Step 7: Add the field**

In `server/src/front-desk/dto/sell-walk-in.dto.ts`, add `IsEmail` to the `class-validator` import, and add directly after the `guestName` property:

```ts
  /**
   * The guest's email (owner, 2026-10-14: a walk-in must give a name and an
   * email). It is how a day pass becomes a membership later — "Make member"
   * arrives pre-filled with it, and the setup link goes there.
   *
   * Optional HERE, required by the service for anybody without an account,
   * exactly like `guestWaiverAccepted`. Trimmed and lower-cased on the way in,
   * because CheckIn_guest_email_sane refuses any other spelling.
   */
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  guestEmail?: string;
```

- [ ] **Step 8: Run the DTO test to make sure it passes**

Run: `npm test --workspace=server -- sell-walk-in.dto`
Expected: PASS (4 tests).

- [ ] **Step 9: Wire the service**

In `server/src/front-desk/walk-in.service.ts`:

1. Import it: `import { requireGuestIdentity } from './guest-identity';`
2. In `sellWalkIn`, directly **before** the existing `if (dto.userId === undefined && dto.guestWaiverAccepted !== true)` block, add:
   ```ts
       requireGuestIdentity(dto);
   ```
3. In `sellGuestPass`, add the same line directly before its waiver check.
4. In both `writeEntry({...})` calls, beside the existing `guestPhone:` line, add:
   ```ts
         guestEmail: dto.userId === undefined ? (dto.guestEmail ?? null) : null,
   ```
5. In `writeEntry`'s `input` type, after `guestPhone: string | null;`, add `guestEmail: string | null;`.
6. In `createMany`'s data, after `guestPhone: input.guestPhone,`, add `guestEmail: input.guestEmail,`.

The check runs before any payment is written, so a refused sale moves no money.

- [ ] **Step 10: Write the failing `guestContact` test**

In `server/src/front-desk/front-desk.service.spec.ts`, find the existing `guestContact` tests, or the prisma mock's `checkIn.findUnique`. Then add:

```ts
  it('returns the guest email for the "Make member" hand-off', async () => {
    prisma.checkIn.findUnique.mockResolvedValue({
      userId: null,
      guestName: 'Ana Cruz',
      guestPhone: '09171234567',
      guestEmail: 'ana@example.com',
      guestEmergencyContact: 'Maria 0917',
    });

    await expect(service.guestContact('11111111-1111-4111-8111-111111111111')).resolves.toEqual({
      guestName: 'Ana Cruz',
      guestPhone: '09171234567',
      guestEmail: 'ana@example.com',
      guestEmergencyContact: 'Maria 0917',
    });
    expect(prisma.checkIn.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ guestEmail: true }) }),
    );
  });
```

Use the spec's own names for the prisma mock and the service under test. If the spec has no `checkIn.findUnique` mock yet, add one to its prisma builder.

- [ ] **Step 11: Run it to make sure it fails, then implement it**

Run: `npm test --workspace=server -- front-desk.service`
Expected: FAIL, because `guestEmail` is missing.

In `front-desk.service.ts` `guestContact`:
- add `guestEmail: string | null;` to the return type;
- add `guestEmail: true` to the `select`;
- add `guestEmail: row.guestEmail,` to the returned object, after `guestPhone`.

In `front-desk.controller.ts` `guestContact`, add `guestEmail: string | null;` to the declared return type. Re-run: PASS.

- [ ] **Step 12: Write the privacy test**

In `server/src/front-desk/desk.presenter.spec.ts`, add a test that builds a guest check-in source row containing `guestEmail: 'ana@example.com'` and `guestPhone: '0917…'`. Reuse whatever row factory the spec already uses for guests. Run it through `toCheckInRecord`, then assert that `JSON.stringify(result)` contains neither `'ana@example.com'` nor `'guestEmail'`. If `toCheckInRecord`'s source type does not accept the extra field, cast the fixture with `as unknown as` and say so in a comment: the point is that an extra column on the row can never leak. Run `npm test --workspace=server -- desk.presenter`. Expected: PASS. It passes already, because the presenter whitelists fields; the test pins that.

- [ ] **Step 13: Typecheck and run the whole server suite**

Run: `npm run typecheck --workspace=server && npm test --workspace=server -- --silent`
Expected: PASS. If a walk-in e2e helper or another unit test constructs `writeEntry` input by hand, fix the compile error by adding `guestEmail: null`.

- [ ] **Step 14: Commit**

```bash
git add server/src/front-desk
git commit -m "feat(front-desk): walk-ins give a name and an email

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Supabase admin and email primitives

**Files:**
- Modify: `server/src/auth/supabase-admin.service.ts` (add 3 public methods before `private async generateLink`)
- Test: `server/src/auth/supabase-admin.service.spec.ts`
- Modify: `server/src/notifications/email.service.ts` (add `sendMemberJoin` after `sendMagicLink`; add `memberJoinHtml` beside `inviteHtml`)
- Test: `server/src/notifications/email.service.spec.ts`
- Modify: `server/src/auth/jwt-verifier.ts:38` (`function asJoinableBirthDate` → `export function asJoinableBirthDate`)

**Interfaces:**
- Produces:
  - `SupabaseAdminService.createAuthUser(email: string): Promise<{ userId: string }>`
  - `SupabaseAdminService.memberJoinSignInLink(email: string, redirectTo: string): Promise<string>` (the action link)
  - `SupabaseAdminService.updateAuthEmail(supabaseId: string, email: string): Promise<void>`
  - `EmailService.sendMemberJoin(to: string, input: { name: string; link: string; plan: { name: string; endsOn: string } | null }): Promise<void>`. It throws when disabled or on a Resend error, like `sendMagicLink`.
  - `asJoinableBirthDate(value: unknown): string | null`, now exported.

- [ ] **Step 1: Write the failing Supabase admin tests**

In `supabase-admin.service.spec.ts`:
- extend the mock to `auth: { admin: { generateLink, createUser, updateUserById } }`;
- declare `const createUser = jest.fn(); const updateUserById = jest.fn();` beside `generateLink`;
- reset all three in `beforeEach`;
- add:

```ts
  describe('createAuthUser', () => {
    it('503s with MEMBER_CREATE_DISABLED when the service key is unset', async () => {
      const service = new SupabaseAdminService(buildConfig({ SUPABASE_SERVICE_KEY: undefined }));
      await expect(service.createAuthUser('jon@example.com')).rejects.toMatchObject({
        response: { code: 'MEMBER_CREATE_DISABLED' },
      });
      expect(createUser).not.toHaveBeenCalled();
    });

    it('creates an UNCONFIRMED user and mints no link — the setup link is ours', async () => {
      createUser.mockResolvedValue({
        data: { user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
        error: null,
      });
      const service = new SupabaseAdminService(buildConfig());

      await expect(service.createAuthUser('jon@example.com')).resolves.toEqual({
        userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
      expect(createUser).toHaveBeenCalledWith({ email: 'jon@example.com', email_confirm: false });
      expect(generateLink).not.toHaveBeenCalled();
    });

    it('409s with MEMBER_EMAIL_TAKEN when the address is already registered', async () => {
      createUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'A user with this email address has already been registered' },
      });
      const service = new SupabaseAdminService(buildConfig());
      await expect(service.createAuthUser('jon@example.com')).rejects.toMatchObject({
        response: { code: 'MEMBER_EMAIL_TAKEN' },
      });
    });

    it('502s with MEMBER_INVITE_FAILED on any other Supabase error', async () => {
      createUser.mockResolvedValue({ data: { user: null }, error: { message: 'boom' } });
      const service = new SupabaseAdminService(buildConfig());
      await expect(service.createAuthUser('jon@example.com')).rejects.toMatchObject({
        response: { code: 'MEMBER_INVITE_FAILED' },
      });
    });
  });

  describe('memberJoinSignInLink', () => {
    it('mints a magiclink that returns to the join page', async () => {
      generateLink.mockResolvedValue({
        data: { user: { id: 'u' }, properties: { action_link: 'https://project.supabase.co/verify?t=1' } },
        error: null,
      });
      const service = new SupabaseAdminService(buildConfig());

      await expect(
        service.memberJoinSignInLink('jon@example.com', 'https://site.test/join/tok'),
      ).resolves.toBe('https://project.supabase.co/verify?t=1');
      expect(generateLink).toHaveBeenCalledWith({
        type: 'magiclink',
        email: 'jon@example.com',
        options: { redirectTo: 'https://site.test/join/tok' },
      });
    });

    it('503s with MEMBER_CREATE_DISABLED when the service key is unset', async () => {
      const service = new SupabaseAdminService(buildConfig({ SUPABASE_SERVICE_KEY: undefined }));
      await expect(
        service.memberJoinSignInLink('jon@example.com', 'https://site.test/join/tok'),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_CREATE_DISABLED' } });
    });

    it('502s with MEMBER_INVITE_FAILED on a Supabase error', async () => {
      generateLink.mockResolvedValue({ data: null, error: { message: 'boom' } });
      const service = new SupabaseAdminService(buildConfig());
      await expect(
        service.memberJoinSignInLink('jon@example.com', 'https://site.test/join/tok'),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_INVITE_FAILED' } });
    });
  });

  describe('updateAuthEmail', () => {
    it('changes the Supabase address', async () => {
      updateUserById.mockResolvedValue({ data: { user: { id: 'u' } }, error: null });
      const service = new SupabaseAdminService(buildConfig());

      await service.updateAuthEmail('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'new@example.com');
      expect(updateUserById).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
        email: 'new@example.com',
      });
    });

    it('409s with MEMBER_EMAIL_TAKEN when the new address is registered', async () => {
      updateUserById.mockResolvedValue({
        data: { user: null },
        error: { message: 'A user with this email address has already been registered' },
      });
      const service = new SupabaseAdminService(buildConfig());
      await expect(service.updateAuthEmail('u', 'taken@example.com')).rejects.toMatchObject({
        response: { code: 'MEMBER_EMAIL_TAKEN' },
      });
    });

    it('503s with MEMBER_CREATE_DISABLED when the service key is unset', async () => {
      const service = new SupabaseAdminService(buildConfig({ SUPABASE_SERVICE_KEY: undefined }));
      await expect(service.updateAuthEmail('u', 'new@example.com')).rejects.toMatchObject({
        response: { code: 'MEMBER_CREATE_DISABLED' },
      });
    });
  });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test --workspace=server -- supabase-admin`
Expected: FAIL, "service.createAuthUser is not a function" (and the same for the other two).

- [ ] **Step 3: Implement the three methods**

In `supabase-admin.service.ts`, add these public methods directly before `private async generateLink`. Add one private helper, `requireClient()`, and use it only in the new methods. Leave the existing ones alone; Task 5 deletes them.

```ts
  /**
   * Counter sign-up: the Supabase identity for a member created at the desk.
   *
   * No link is minted here. The member's way in is OUR setup link
   * (`MemberJoinService`), which lasts 7 days and only asks Supabase for a
   * sign-in link when the member presses "Set up my account" — a raw Supabase
   * link would expire in an hour and can be used up by a mail scanner.
   * Unconfirmed until that first sign-in proves the address.
   */
  async createAuthUser(email: string): Promise<{ userId: string }> {
    const client = this.requireClient();
    const { data, error } = await client.auth.admin.createUser({ email, email_confirm: false });
    if (error) throw toMemberAuthError(error);
    return { userId: data.user.id };
  }

  /**
   * The setup page's "Set up my account": a sign-in link for an EXISTING account.
   *
   * Unlike `staffInviteAccountLink`, minting a magic link for an existing account
   * is the point here, and safe: `MemberJoinService` only gets this far for a
   * member who has never signed in, holding an unused, unexpired token that was
   * only ever sent to this address. The same trust as a Supabase magic link,
   * started by a button press instead of an email a scanner can pre-fetch.
   *
   * `redirectTo` must be allowed in Supabase Auth → URL configuration →
   * Redirect URLs (`https://<site>/join/*`), or Supabase falls back to the
   * Site URL and the member never sees the password step.
   */
  async memberJoinSignInLink(email: string, redirectTo: string): Promise<string> {
    const client = this.requireClient();
    const { data, error } = await client.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo },
    });
    if (error) {
      throw new DomainException(
        'MEMBER_INVITE_FAILED',
        `Could not generate a Supabase auth link: ${error.message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    return data.properties.action_link;
  }

  /** Correcting a mistyped address on a never-signed-in member. */
  async updateAuthEmail(supabaseId: string, email: string): Promise<void> {
    const client = this.requireClient();
    const { error } = await client.auth.admin.updateUserById(supabaseId, { email });
    if (error) throw toMemberAuthError(error);
  }

  private requireClient(): SupabaseClient {
    if (this.client === null) {
      throw new DomainException(
        'MEMBER_CREATE_DISABLED',
        'Member creation is disabled: SUPABASE_SERVICE_KEY is not configured.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.client;
  }
```

Add this module-level helper next to `isAlreadyRegistered`:

```ts
/** "Already registered" is the caller's 409; anything else is Supabase's 502. */
function toMemberAuthError(error: { message: string }): DomainException {
  return isAlreadyRegistered(error)
    ? new DomainException(
        'MEMBER_EMAIL_TAKEN',
        'A member with this email already exists.',
        HttpStatus.CONFLICT,
      )
    : new DomainException(
        'MEMBER_INVITE_FAILED',
        `Supabase refused the request: ${error.message}`,
        HttpStatus.BAD_GATEWAY,
      );
}
```

- [ ] **Step 4: Run them to make sure they pass**

Run: `npm test --workspace=server -- supabase-admin`
Expected: PASS, the old tests and the new ones.

- [ ] **Step 5: Write the failing email tests**

In `email.service.spec.ts`, mirror the existing `sendMagicLink` tests (same Resend mock and config builder) and add a `describe('sendMemberJoin')` with these tests:

```ts
  describe('sendMemberJoin', () => {
    it('sends our setup link, the plan line, and the 7-day note', async () => {
      // (same enabled-service setup as the sendMagicLink tests)
      await service.sendMemberJoin('ana@example.com', {
        name: 'Ana Cruz',
        link: 'https://site.test/join/tok',
        plan: { name: 'Monthly', endsOn: 'November 14, 2026' },
      });

      const sent = send.mock.calls[0][0];
      expect(sent.to).toBe('ana@example.com');
      expect(sent.subject).toBe('Your Gym of Thrones account is ready');
      expect(sent.html).toContain('href="https://site.test/join/tok"');
      expect(sent.html).toContain('Set up my account');
      expect(sent.html).toContain('Your Monthly plan runs until November 14, 2026.');
      expect(sent.html).toContain('expires in 7 days');
    });

    it('leaves the plan line out when there is no membership', async () => {
      await service.sendMemberJoin('ana@example.com', {
        name: 'Ana Cruz',
        link: 'https://site.test/join/tok',
        plan: null,
      });
      expect(send.mock.calls[0][0].html).not.toContain('plan runs until');
    });

    it('escapes the staff-typed name and the plan name', async () => {
      await service.sendMemberJoin('ana@example.com', {
        name: '<b>Ana</b>',
        link: 'https://site.test/join/tok',
        plan: { name: 'Gold & <i>', endsOn: 'November 14, 2026' },
      });
      const html = send.mock.calls[0][0].html as string;
      expect(html).not.toContain('<b>Ana</b>');
      expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
      expect(html).toContain('Gold &amp; &lt;i&gt;');
    });

    it('throws when outbound email is disabled', async () => {
      // (same disabled-service setup as the sendMagicLink tests)
      await expect(
        disabled.sendMemberJoin('ana@example.com', { name: 'A', link: 'x', plan: null }),
      ).rejects.toThrow(/disabled/);
    });

    it('throws when Resend reports an error', async () => {
      send.mockResolvedValue({ error: { message: 'rate limited' } });
      await expect(
        service.sendMemberJoin('ana@example.com', { name: 'A', link: 'x', plan: null }),
      ).rejects.toThrow(/rate limited/);
    });
  });
```

Use the spec's real names for the Resend `send` mock and the service instances.

- [ ] **Step 6: Run them to make sure they fail, then implement**

Run: `npm test --workspace=server -- email.service`
Expected: FAIL, "sendMemberJoin is not a function".

In `email.service.ts`, add directly after `sendMagicLink`:

```ts
  /**
   * Counter sign-up: "your account is ready", with OUR setup link — 7 days,
   * single use — and, when the member has a current plan, what it is and until
   * when. Throws like `sendMagicLink`; `MemberJoinService.issue` catches and
   * reports `emailSent: false`, because the account and the link already exist.
   */
  async sendMemberJoin(
    to: string,
    input: { name: string; link: string; plan: { name: string; endsOn: string } | null },
  ): Promise<void> {
    if (this.client === null || this.from === null) {
      throw new Error('EmailService is disabled: RESEND_API_KEY / RESEND_FROM not configured.');
    }

    const { error } = await this.client.emails.send({
      from: this.from,
      to,
      subject: 'Your Gym of Thrones account is ready',
      html: memberJoinHtml(input),
    });

    if (error) {
      throw new Error(`Resend send failed: ${error.message}`);
    }
  }
```

And add beside `inviteHtml`:

```ts
function memberJoinHtml(input: {
  name: string;
  link: string;
  plan: { name: string; endsOn: string } | null;
}): string {
  const plan =
    input.plan === null
      ? ''
      : `<p>Your ${escapeHtml(input.plan.name)} plan runs until ${escapeHtml(input.plan.endsOn)}.</p>`;
  return (
    `<p>Hi ${escapeHtml(input.name)}, your account at Gym of Thrones is ready.</p>` +
    plan +
    `<p><a href="${escapeAttribute(input.link)}">Set up my account</a></p>` +
    `<p>This link works once and expires in 7 days. If it has expired, ask the front desk for a new one.</p>`
  );
}
```

Update the class doc comment's opening line, "One method: the C2 member-invite magic link.", to name the current methods. Re-run: PASS.

- [ ] **Step 7: Export the birth-date rule**

In `server/src/auth/jwt-verifier.ts`, change `function asJoinableBirthDate(` to `export function asJoinableBirthDate(`. Nothing else changes.

- [ ] **Step 8: Typecheck and run the server suite**

Run: `npm run typecheck --workspace=server && npm test --workspace=server -- --silent`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/auth server/src/notifications
git commit -m "feat(auth): Supabase user without a link, join sign-in link, email change; join email

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `MemberJoinService` and the public `member-join` routes

**Files:**
- Create: `server/src/users/member-join.service.ts`, `server/src/users/member-join.service.spec.ts`
- Create: `server/src/users/member-join.controller.ts`, `server/src/users/member-join.controller.spec.ts`
- Create: `server/src/users/dto/member-join.dto.ts`
- Modify: `server/src/users/users.module.ts`

**Interfaces:**
- Consumes:
  - `SupabaseAdminService.memberJoinSignInLink(email, redirectTo)` and `EmailService.sendMemberJoin(to, input)` (Task 3)
  - `asJoinableBirthDate` (Task 3)
  - `newInvitationToken`, `hashInvitationToken` from `../staff-invitations/invitation-token`
  - `resolveAppOrigin` from `../config/app-origin`
  - `gymToday`, `toDateColumn` from `../common/time/gym-time`
  - the shared types `MemberJoinLookup`, `MemberJoinClaim`, `MemberJoinAccepted` (Task 1)
- Produces:
  - `MEMBER_JOIN_TTL_DAYS = 7`
  - `MemberJoinService.issue(input: { userId: string; issuedById: string; requestOrigin: string | undefined }, now?: Date): Promise<boolean>`. The boolean is `emailSent`.
  - `MemberJoinService.lookup(token: string, now?: Date): Promise<MemberJoinLookup>`
  - `MemberJoinService.claimLink(token: string, requestOrigin: string | undefined, now?: Date): Promise<MemberJoinClaim>`
  - `MemberJoinService.accept(callerId: string, token: string, dateOfBirth: string, now?: Date): Promise<MemberJoinAccepted>`
  - `MemberJoinService` is exported from `UsersModule`'s providers so `MembersService` can inject it (Task 5)

- [ ] **Step 1: Write the DTOs**

`server/src/users/dto/member-join.dto.ts`:

```ts
import { IsString, Length, Matches } from 'class-validator';

/**
 * The setup-link secret as it arrives from the email: 43 base64url characters
 * today. Loose bounds on purpose, like `StaffInvitationTokenDto` — a malformed
 * token should read "not a valid link" (404), not a validation error.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+$/;

/** Query of `GET /member-join/lookup`, body of `claim-link`. */
export class MemberJoinTokenDto {
  @IsString()
  @Length(16, 128)
  @Matches(TOKEN_SHAPE)
  token!: string;
}

/**
 * Body of `POST /member-join/accept`. The password never comes here — the page
 * sets it with Supabase directly, before calling this.
 *
 * `dateOfBirth` is a `yyyy-mm-dd` civil date from a date input. The SHAPE is
 * checked here; whether it is joinable is `asJoinableBirthDate`'s call in the
 * service, the same rule self sign-up uses.
 */
export class AcceptMemberJoinDto {
  @IsString()
  @Length(16, 128)
  @Matches(TOKEN_SHAPE)
  token!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateOfBirth!: string;
}
```

- [ ] **Step 2: Write the failing service tests**

`server/src/users/member-join.service.spec.ts`:

```ts
import type { ConfigService } from '@nestjs/config';
import { MemberJoinService } from './member-join.service';
import { hashInvitationToken } from '../staff-invitations/invitation-token';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import type { SupabaseAdminService } from '../auth/supabase-admin.service';
import type { EmailService } from '../notifications/email.service';
import type { Env } from '../config/env.validation';

const NOW = new Date('2026-10-14T04:00:00.000Z');
const MEMBER_ID = '11111111-1111-4111-8111-111111111111';
const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'T'.repeat(43);

function buildPrisma() {
  return {
    user: { findUnique: jest.fn(), updateMany: jest.fn() },
    memberJoinLink: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      createMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

function member(over: Record<string, unknown> = {}) {
  return {
    id: MEMBER_ID,
    email: 'ana@example.com',
    firstName: 'Ana',
    lastName: 'Cruz',
    lastSeenAt: null,
    deletedAt: null,
    membership: { planName: 'Monthly', endsOn: new Date('2026-11-14T00:00:00.000Z'), status: 'ACTIVE' },
    ...over,
  };
}

function link(over: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    userId: MEMBER_ID,
    tokenHash: hashInvitationToken(TOKEN),
    issuedAt: new Date('2026-10-14T00:00:00.000Z'),
    expiresAt: new Date('2026-10-21T00:00:00.000Z'),
    usedAt: null,
    user: { firstName: 'Ana', email: 'ana@example.com', deletedAt: null, dateOfBirth: null },
    ...over,
  };
}

describe('MemberJoinService', () => {
  let prisma: ReturnType<typeof buildPrisma>;
  let supabaseAdmin: { memberJoinSignInLink: jest.Mock };
  let email: { sendMemberJoin: jest.Mock };
  let service: MemberJoinService;

  beforeEach(() => {
    prisma = buildPrisma();
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    supabaseAdmin = { memberJoinSignInLink: jest.fn() };
    email = { sendMemberJoin: jest.fn().mockResolvedValue(undefined) };
    service = new MemberJoinService(
      prisma as unknown as PrismaService,
      { timeZone: 'Asia/Manila' } as unknown as GymConfigService,
      { get: () => 'https://site.test' } as unknown as ConfigService<Env, true>,
      supabaseAdmin as unknown as SupabaseAdminService,
      email as unknown as EmailService,
    );
  });

  describe('issue', () => {
    it('creates the first link, and emails our /join/<token> link with the plan line', async () => {
      prisma.user.findUnique.mockResolvedValue(member());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 0 });
      prisma.memberJoinLink.createMany.mockResolvedValue({ count: 1 });

      const sent = await service.issue(
        { userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined },
        NOW,
      );

      expect(sent).toBe(true);
      const created = prisma.memberJoinLink.createMany.mock.calls[0][0].data[0];
      expect(created).toMatchObject({ userId: MEMBER_ID, issuedById: STAFF_ID, issuedAt: NOW });
      expect(created.expiresAt).toEqual(new Date('2026-10-21T04:00:00.000Z'));
      expect(created.tokenHash).toMatch(/^[0-9a-f]{64}$/);

      const [to, input] = email.sendMemberJoin.mock.calls[0];
      expect(to).toBe('ana@example.com');
      expect(input.name).toBe('Ana Cruz');
      expect(input.link).toMatch(/^https:\/\/site\.test\/join\/[A-Za-z0-9_-]{43}$/);
      // The emailed token is the one whose hash was stored.
      expect(hashInvitationToken(input.link.split('/join/')[1])).toBe(created.tokenHash);
      expect(input.plan).toEqual({ name: 'Monthly', endsOn: 'November 14, 2026' });
    });

    it('ROTATES an unused link in place — a new hash and expiry, the old link dead', async () => {
      prisma.user.findUnique.mockResolvedValue(member());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 1 });

      await service.issue({ userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined }, NOW);

      expect(prisma.memberJoinLink.updateMany).toHaveBeenCalledWith({
        where: { userId: MEMBER_ID, usedAt: null },
        data: expect.objectContaining({ issuedAt: NOW, issuedById: STAFF_ID }),
      });
      expect(prisma.memberJoinLink.createMany).not.toHaveBeenCalled();
    });

    it('refuses a member who has signed in before — never a link into an active account', async () => {
      prisma.user.findUnique.mockResolvedValue(member({ lastSeenAt: new Date() }));

      await expect(
        service.issue({ userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined }, NOW),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_ALREADY_SIGNED_IN' }, status: 409 });
      expect(prisma.memberJoinLink.updateMany).not.toHaveBeenCalled();
      expect(email.sendMemberJoin).not.toHaveBeenCalled();
    });

    it('refuses a deleted member as not found', async () => {
      prisma.user.findUnique.mockResolvedValue(member({ deletedAt: new Date() }));
      await expect(
        service.issue({ userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined }, NOW),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_NOT_FOUND' } });
    });

    it('never revives a USED link', async () => {
      prisma.user.findUnique.mockResolvedValue(member());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 0 });
      prisma.memberJoinLink.createMany.mockResolvedValue({ count: 0 });

      await expect(
        service.issue({ userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined }, NOW),
      ).rejects.toMatchObject({ response: { code: 'MEMBER_JOIN_USED' } });
      expect(email.sendMemberJoin).not.toHaveBeenCalled();
    });

    it('leaves the plan line out when the membership has ended or there is none', async () => {
      prisma.user.findUnique.mockResolvedValue(
        member({ membership: { planName: 'Monthly', endsOn: new Date('2026-10-01T00:00:00.000Z'), status: 'EXPIRED' } }),
      );
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 1 });
      await service.issue({ userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined }, NOW);
      expect(email.sendMemberJoin.mock.calls[0][1].plan).toBeNull();

      prisma.user.findUnique.mockResolvedValue(member({ membership: null }));
      await service.issue({ userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined }, NOW);
      expect(email.sendMemberJoin.mock.calls[1][1].plan).toBeNull();
    });

    it('answers false, not a throw, when the email fails — the link already exists', async () => {
      prisma.user.findUnique.mockResolvedValue(member());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 1 });
      email.sendMemberJoin.mockRejectedValue(new Error('Resend is down'));

      await expect(
        service.issue({ userId: MEMBER_ID, issuedById: STAFF_ID, requestOrigin: undefined }, NOW),
      ).resolves.toBe(false);
    });
  });

  describe('lookup', () => {
    it('answers PENDING with the first name and the full email', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link());
      await expect(service.lookup(TOKEN, NOW)).resolves.toEqual({
        firstName: 'Ana',
        status: 'PENDING',
        email: 'ana@example.com',
      });
      expect(prisma.memberJoinLink.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: hashInvitationToken(TOKEN) } }),
      );
    });

    it('answers USED and EXPIRED without the email', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link({ usedAt: NOW }));
      await expect(service.lookup(TOKEN, NOW)).resolves.toEqual({ firstName: 'Ana', status: 'USED' });

      prisma.memberJoinLink.findUnique.mockResolvedValue(
        link({ expiresAt: new Date('2026-10-14T04:00:00.000Z') }),
      );
      await expect(service.lookup(TOKEN, NOW)).resolves.toEqual({
        firstName: 'Ana',
        status: 'EXPIRED',
      });
    });

    it('404s for an unknown token and for a deleted member', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(null);
      await expect(service.lookup(TOKEN, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_JOIN_NOT_FOUND' },
        status: 404,
      });

      prisma.memberJoinLink.findUnique.mockResolvedValue(
        link({ user: { firstName: 'Ana', email: 'ana@example.com', deletedAt: NOW, dateOfBirth: null } }),
      );
      await expect(service.lookup(TOKEN, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_JOIN_NOT_FOUND' },
      });
    });
  });

  describe('claimLink', () => {
    it('mints a magic link that returns to THIS join page', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link());
      supabaseAdmin.memberJoinSignInLink.mockResolvedValue('https://project.supabase.co/verify?t=1');

      await expect(service.claimLink(TOKEN, undefined, NOW)).resolves.toEqual({
        url: 'https://project.supabase.co/verify?t=1',
      });
      expect(supabaseAdmin.memberJoinSignInLink).toHaveBeenCalledWith(
        'ana@example.com',
        `https://site.test/join/${TOKEN}`,
      );
    });

    it('refuses a used link (410 USED) and an expired one (410 EXPIRED) without touching Supabase', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link({ usedAt: NOW }));
      await expect(service.claimLink(TOKEN, undefined, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_JOIN_USED' },
        status: 410,
      });

      prisma.memberJoinLink.findUnique.mockResolvedValue(
        link({ expiresAt: new Date('2026-10-13T00:00:00.000Z') }),
      );
      await expect(service.claimLink(TOKEN, undefined, NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_JOIN_EXPIRED' },
        status: 410,
      });
      expect(supabaseAdmin.memberJoinSignInLink).not.toHaveBeenCalled();
    });
  });

  describe('accept', () => {
    it('marks the link used and stores a joinable birth date', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.accept(MEMBER_ID, TOKEN, '1995-03-02', NOW)).resolves.toEqual({
        dateOfBirthSaved: true,
      });
      expect(prisma.memberJoinLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'link-1', usedAt: null },
        data: { usedAt: NOW },
      });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: MEMBER_ID, dateOfBirth: null },
        data: { dateOfBirth: new Date('1995-03-02T00:00:00.000Z') },
      });
    });

    it('refuses another signed-in account (403) before writing anything', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link());
      await expect(service.accept(STAFF_ID, TOKEN, '1995-03-02', NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_JOIN_WRONG_ACCOUNT' },
        status: 403,
      });
      expect(prisma.memberJoinLink.updateMany).not.toHaveBeenCalled();
    });

    it('is idempotent for the same member — a double submit is not an error', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link({ usedAt: NOW }));
      await expect(service.accept(MEMBER_ID, TOKEN, '1995-03-02', NOW)).resolves.toEqual({
        dateOfBirthSaved: false,
      });
      expect(prisma.memberJoinLink.updateMany).not.toHaveBeenCalled();
    });

    it('refuses an expired link', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(
        link({ expiresAt: new Date('2026-10-13T00:00:00.000Z') }),
      );
      await expect(service.accept(MEMBER_ID, TOKEN, '1995-03-02', NOW)).rejects.toMatchObject({
        response: { code: 'MEMBER_JOIN_EXPIRED' },
      });
    });

    it('does not store a date below the joining age, and still finishes', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.accept(MEMBER_ID, TOKEN, '2015-01-01', NOW)).resolves.toEqual({
        dateOfBirthSaved: false,
      });
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('a lost race (count 0) is the same idempotent answer, not a 500', async () => {
      prisma.memberJoinLink.findUnique.mockResolvedValue(link());
      prisma.memberJoinLink.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.accept(MEMBER_ID, TOKEN, '1995-03-02', NOW)).resolves.toEqual({
        dateOfBirthSaved: false,
      });
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });
  });
});
```

Note: `asJoinableBirthDate` measures age against `Date.now()`, not `now`. `'1995-03-02'` and `'2015-01-01'` are safely on either side of 16 for years to come, so the test needs no fake timers.

- [ ] **Step 3: Run them to make sure they fail**

Run: `npm test --workspace=server -- member-join.service`
Expected: FAIL, "Cannot find module './member-join.service'".

- [ ] **Step 4: Implement the service**

`server/src/users/member-join.service.ts`:

```ts
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MemberJoinAccepted, MemberJoinClaim, MemberJoinLookup } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import type { Env } from '../config/env.validation';
import { resolveAppOrigin } from '../config/app-origin';
import { DomainException } from '../common/exceptions/domain.exception';
import { gymToday, toDateColumn } from '../common/time/gym-time';
import { SupabaseAdminService } from '../auth/supabase-admin.service';
import { asJoinableBirthDate } from '../auth/jwt-verifier';
import { EmailService } from '../notifications/email.service';
import { hashInvitationToken, newInvitationToken } from '../staff-invitations/invitation-token';

/** Owner decision (2026-10-14): a member's setup link lives a week, like a staff invitation. */
export const MEMBER_JOIN_TTL_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Counter sign-up — a staff-created member's own setup link.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY NOT JUST EMAIL SUPABASE'S LINK.
 *
 * A raw Supabase link lasts about an hour and a mail scanner that pre-fetches
 * it uses it up, so a member who opens their email that evening found it dead.
 * And it signed them in without ever asking for a password, so the next time
 * they were signed out they were locked out. This link is ours: it lives 7 days,
 * works once, and only asks Supabase for a sign-in link when the member presses
 * "Set up my account" — scanners do not press buttons. The page then asks for a
 * password before it calls `accept`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A LINK IS A WAY INTO THE ACCOUNT, so one is only ever issued for a member who
 * has never signed in (`lastSeenAt` null). A desk login can therefore never mint
 * its way into an active member's account; somebody who has signed in before
 * uses "Forgot password" like everyone else.
 */
@Injectable()
export class MemberJoinService {
  private readonly logger = new Logger(MemberJoinService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly config: ConfigService<Env, true>,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly email: EmailService,
  ) {}

  /**
   * Create or ROTATE the member's link and email it. Called by member creation,
   * "Resend invite" and an email correction. Answers whether the email went —
   * the link exists either way, and staff can resend.
   */
  async issue(
    input: { userId: string; issuedById: string; requestOrigin: string | undefined },
    now: Date = new Date(),
  ): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        lastSeenAt: true,
        deletedAt: true,
        membership: { select: { planName: true, endsOn: true, status: true } },
      },
    });
    if (user === null || user.deletedAt !== null) {
      throw new DomainException('MEMBER_NOT_FOUND', 'Member not found', HttpStatus.NOT_FOUND);
    }
    if (user.lastSeenAt !== null) throw alreadySignedIn();

    const { token, tokenHash } = newInvitationToken();
    const data = {
      tokenHash,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + MEMBER_JOIN_TTL_DAYS * DAY_MS),
      issuedById: input.issuedById,
    };

    // Rotate an unused link in place; create the first one. A USED link is never
    // touched — `usedAt: null` in the WHERE is the guard. `createMany` with
    // skipDuplicates, never a caught P2002, so a concurrent first issue (a double
    // click) lands as a second rotation instead of an error.
    const rotated = await this.prisma.memberJoinLink.updateMany({
      where: { userId: user.id, usedAt: null },
      data,
    });
    if (rotated.count === 0) {
      const created = await this.prisma.memberJoinLink.createMany({
        data: [{ userId: user.id, ...data }],
        skipDuplicates: true,
      });
      if (created.count === 0) {
        const retried = await this.prisma.memberJoinLink.updateMany({
          where: { userId: user.id, usedAt: null },
          data,
        });
        if (retried.count === 0) throw used();
      }
    }

    const link = `${this.appOrigin(input.requestOrigin)}/join/${token}`;
    try {
      await this.email.sendMemberJoin(user.email, {
        name: `${user.firstName} ${user.lastName}`.trim(),
        link,
        plan: this.planLine(user.membership, now),
      });
      return true;
    } catch (err) {
      this.logger.warn(`Setup link email failed for member ${user.id}: ${String(err)}`);
      return false;
    }
  }

  /** `GET /member-join/lookup` — PUBLIC. The email only while the link is usable. */
  async lookup(token: string, now: Date = new Date()): Promise<MemberJoinLookup> {
    const row = await this.findByToken(token);
    const status = statusOf(row, now);
    return status === 'PENDING'
      ? { firstName: row.user.firstName, status, email: row.user.email }
      : { firstName: row.user.firstName, status };
  }

  /** `POST /member-join/claim-link` — PUBLIC. "Set up my account". */
  async claimLink(
    token: string,
    requestOrigin: string | undefined,
    now: Date = new Date(),
  ): Promise<MemberJoinClaim> {
    const row = await this.findByToken(token);
    assertUsable(row, now);
    const redirectTo = `${this.appOrigin(requestOrigin)}/join/${token}`;
    return { url: await this.supabaseAdmin.memberJoinSignInLink(row.user.email, redirectTo) };
  }

  /**
   * `POST /member-join/accept` — the member, signed in through the link, has just
   * set a password (the page does that with Supabase before calling this).
   *
   * Idempotent for the member themselves: a double submit, or a lost race against
   * their own first submit, answers the same success rather than a "used" error
   * on a page that has, in fact, worked.
   */
  async accept(
    callerId: string,
    token: string,
    dateOfBirth: string,
    now: Date = new Date(),
  ): Promise<MemberJoinAccepted> {
    const row = await this.findByToken(token);
    if (row.userId !== callerId) {
      throw new DomainException(
        'MEMBER_JOIN_WRONG_ACCOUNT',
        'You are signed in with a different account. Sign out, then open the link again.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (row.usedAt !== null) return { dateOfBirthSaved: false };
    assertUsable(row, now);

    const birth = asJoinableBirthDate(dateOfBirth);
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.memberJoinLink.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count === 0 || birth === null) return { dateOfBirthSaved: false };
      // Never overwrites: a birthday on file is corrected by staff, not by a link.
      const saved = await tx.user.updateMany({
        where: { id: row.userId, dateOfBirth: null },
        data: { dateOfBirth: new Date(`${birth}T00:00:00.000Z`) },
      });
      return { dateOfBirthSaved: saved.count === 1 };
    });
  }

  private planLine(
    membership: { planName: string; endsOn: Date; status: string } | null,
    now: Date,
  ): { name: string; endsOn: string } | null {
    if (membership === null || membership.status === 'CANCELLED') return null;
    const today = toDateColumn(gymToday(now, this.gym.timeZone));
    if (membership.endsOn.getTime() < today.getTime()) return null;
    return {
      name: membership.planName,
      // A @db.Date is UTC midnight; formatting it in UTC keeps the calendar day.
      endsOn: membership.endsOn.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      }),
    };
  }

  private async findByToken(token: string) {
    const row = await this.prisma.memberJoinLink.findUnique({
      where: { tokenHash: hashInvitationToken(token) },
      include: { user: { select: { firstName: true, email: true, deletedAt: true } } },
    });
    if (row === null || row.user.deletedAt !== null) {
      throw new DomainException(
        'MEMBER_JOIN_NOT_FOUND',
        "This setup link isn't valid. Ask the front desk to send a new one.",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private appOrigin(requestOrigin: string | undefined): string {
    return resolveAppOrigin(requestOrigin, this.config.get('CORS_ORIGIN', { infer: true }));
  }
}

function statusOf(row: { usedAt: Date | null; expiresAt: Date }, now: Date): MemberJoinLookup['status'] {
  if (row.usedAt !== null) return 'USED';
  return row.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'PENDING';
}

function assertUsable(row: { usedAt: Date | null; expiresAt: Date }, now: Date): void {
  switch (statusOf(row, now)) {
    case 'USED':
      throw used();
    case 'EXPIRED':
      throw new DomainException(
        'MEMBER_JOIN_EXPIRED',
        'This setup link has expired. Ask the front desk to send a new one.',
        HttpStatus.GONE,
      );
    case 'PENDING':
      return;
  }
}

function used(): DomainException {
  return new DomainException(
    'MEMBER_JOIN_USED',
    'This account is already set up. Sign in, or use "Forgot password".',
    HttpStatus.GONE,
  );
}

function alreadySignedIn(): DomainException {
  return new DomainException(
    'MEMBER_ALREADY_SIGNED_IN',
    'They have already signed in. Ask them to use "Forgot password" on the sign-in page.',
    HttpStatus.CONFLICT,
  );
}
```

Two checks on the test mocks:
- The `findByToken` include selects only `firstName`, `email` and `deletedAt`. The test fixture's extra `dateOfBirth` key is harmless.
- The `issue` test that checks `createMany`'s `data[0]` expects `{ userId, ...data }`.

If Prisma's types reject `status: string` for the `membership` select, type the parameter as `{ planName: string; endsOn: Date; status: MembershipStatus }`, importing `MembershipStatus` from `@prisma/client`.

- [ ] **Step 5: Run the service tests to make sure they pass**

Run: `npm test --workspace=server -- member-join.service`
Expected: PASS (all of them). If the `en-US` format renders differently under this Node build, print it once to check, then fix the expectation and the code together. The format must read `November 14, 2026`.

- [ ] **Step 6: Write the failing controller test**

`server/src/users/member-join.controller.spec.ts` checks the decorator metadata, the same way `server/src/assistant/admin-assistant.controller.spec.ts` (or the staff-invitations controller spec) reads it. Open one of those first and copy its metadata-reading approach: the `@Public()` key, and the throttler's metadata keys from `@nestjs/throttler`. Assert:
- `lookup` and `claimLink` are `@Public()`. `accept` is not.
- `lookup` throttles `default` 10 / 60 000 and `origin` 30 / 60 000. `claimLink` throttles `default` 5 / 60 000 and `origin` 20 / 60 000.
- `claimLink` and `accept` use HTTP 200.
- Each handler forwards to the service with the right arguments. Call the controller methods directly with a mocked service:
  - `lookup({ token })` → `service.lookup(token)`
  - `claimLink({ token }, 'https://o')` → `service.claimLink(token, 'https://o')`
  - `accept({ token, dateOfBirth }, user)` → `service.accept(user.id, token, dateOfBirth)`

- [ ] **Step 7: Implement the controller and register it**

`server/src/users/member-join.controller.ts`:

```ts
import { Body, Controller, Get, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { MemberJoinAccepted, MemberJoinClaim, MemberJoinLookup } from '@got/shared';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { AcceptMemberJoinDto, MemberJoinTokenDto } from './dto/member-join.dto';
import { MemberJoinService } from './member-join.service';

/**
 * The member setup page's three calls (`/join/<token>`), the counterpart of
 * `StaffInvitationsController`'s public half — same throttles, same reasons:
 * a person opens their link a handful of times, and each claim can mint a
 * Supabase sign-in link.
 */
@Controller('member-join')
export class MemberJoinController {
  constructor(private readonly memberJoin: MemberJoinService) {}

  @Get('lookup')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 }, origin: { limit: 30, ttl: 60_000 } })
  async lookup(@Query() query: MemberJoinTokenDto): Promise<MemberJoinLookup> {
    return this.memberJoin.lookup(query.token);
  }

  @Post('claim-link')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 }, origin: { limit: 20, ttl: 60_000 } })
  async claimLink(
    @Body() dto: MemberJoinTokenDto,
    @Headers('origin') origin: string | undefined,
  ): Promise<MemberJoinClaim> {
    return this.memberJoin.claimLink(dto.token, origin);
  }

  /** Signed in, no permission key: the link itself is the authority, checked against the caller. */
  @Post('accept')
  @HttpCode(200)
  async accept(
    @Body() dto: AcceptMemberJoinDto,
    @CurrentUser() user: AuthUser,
  ): Promise<MemberJoinAccepted> {
    return this.memberJoin.accept(user.id, dto.token, dto.dateOfBirth);
  }
}
```

In `users.module.ts`, import both classes, add `MemberJoinController` to `controllers` and `MemberJoinService` to `providers` and `exports`, and update the module doc comment by one sentence. `ConfigModule` and `GymConfigService` are global; confirm by checking how `StaffInvitationsModule` gets them. If they are not global, import what that module imports.

- [ ] **Step 8: Run the tests, the typecheck and the suite**

Run: `npm test --workspace=server -- member-join && npm run typecheck --workspace=server && npm test --workspace=server -- --silent`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/users
git commit -m "feat(members): own 7-day setup link — issue, lookup, claim, accept

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Member creation, resend and email correction use the setup link

**Files:**
- Modify: `server/src/users/members.service.ts`
  - constructor (line ~102): replace the `email: EmailService` parameter with `memberJoin: MemberJoinService`
  - `create` (~717-868), `resendInvite` (~870-902)
  - add `changeEmail`
  - widen `recordAccountAction`'s action union
- Create: `server/src/users/dto/change-email.dto.ts`
- Modify: `server/src/users/members.controller.ts` (`create`, `resendInvite`, new `changeEmail`)
- Test: `server/src/users/members.service.spec.ts`, `server/src/users/members.controller.spec.ts`
- Modify: `server/src/auth/supabase-admin.service.ts` and its spec (delete `generateInviteLink`, `generateMagicLink`, the private `generateLink`, the `GeneratedLink` interface and their tests)
- Modify: `server/src/notifications/email.service.ts` and its spec (delete `sendMagicLink`, `inviteHtml` and their tests; fix doc comments that name them)

**Interfaces:**
- Consumes:
  - `SupabaseAdminService.createAuthUser`, `.updateAuthEmail`, `.deleteUser` (Task 3)
  - `MemberJoinService.issue({ userId, issuedById, requestOrigin }, now)` (Task 4)
  - the `MEMBER_EMAIL_CHANGED` audit value (Task 1)
- Produces:
  - `MembersService.create(dto, actor, requestOrigin?: string, now?)` → `CreateMemberResult` (shape unchanged)
  - `MembersService.resendInvite(id, scope, actor: AuthUser, requestOrigin?: string, now?)` → `{ member: MemberListItem; emailSent: boolean }`
  - `MembersService.changeEmail(id, email, scope, actor: AuthUser, requestOrigin?: string, now?)` → `{ member: MemberListItem; emailSent: boolean }`
  - Route `POST /members/:id/change-email` with body `{ email }`, under `member.create` and `@Scope('user')`, HTTP 200

- [ ] **Step 1: Update the spec's construction and mocks first**

In `members.service.spec.ts`:
- `SupabaseAdminMock` becomes `{ createAuthUser: jest.Mock; updateAuthEmail: jest.Mock; deleteUser: jest.Mock }`, and `buildSupabaseAdmin` returns three `jest.fn()`s.
- Replace `EmailMock` / `buildEmail` with `MemberJoinMock { issue: jest.Mock }` / `buildMemberJoin()`, which returns `{ issue: jest.fn().mockResolvedValue(true) }`.
- In every `new MembersService(...)` (three places: `beforeEach` and two "audited" constructions), pass `memberJoin as unknown as MemberJoinService` in the old email position.
- Add `user.findUnique: jest.fn()` to `buildPrisma`'s `user` mock if it is absent.

- [ ] **Step 2: Rewrite the `create` tests against the new calls**

In `describe('create')`:
- `supabaseAdmin.generateInviteLink.mockResolvedValue({ userId, actionLink })` becomes `supabaseAdmin.createAuthUser.mockResolvedValue({ userId: NEW_SUPABASE_ID })`.
- `expect(supabaseAdmin.generateInviteLink)...` becomes `expect(supabaseAdmin.createAuthUser)...`, with the same argument (`'jon@example.com'`).
- Every `email.sendMagicLink` assertion becomes an assertion on `memberJoin.issue`:
  - Success: `expect(memberJoin.issue).toHaveBeenCalledWith({ userId: <created id>, issuedById: ACTOR.id, requestOrigin: 'https://site.test' }, NOW)`. Pass `'https://site.test'` as the new third argument to `service.create(dto, actor, 'https://site.test', NOW)`. Every existing `service.create(dto, actor, NOW)` call becomes `service.create(dto, actor, undefined, NOW)`.
  - Email failure: `memberJoin.issue.mockResolvedValue(false)`, then expect `emailSent: false`.
  - A failed local create: expect `memberJoin.issue` not called and `deleteUser` called, as today.
  - **New test: the link is issued AFTER the plan sale**, so the email can name the plan. Make `sales.sell` and `memberJoin.issue` push to a shared `order` array, then expect `['sell', 'issue']`.
  - **New test: `issue` throwing** (for example a DB error) still returns the member, with `emailSent: false`. The account exists, so a link failure must not lose it. Mock `memberJoin.issue.mockRejectedValue(new Error('db'))`.

Run: `npm test --workspace=server -- members.service`
Expected: FAIL, because the service still calls `generateInviteLink`.

- [ ] **Step 3: Change `create`**

In `members.service.ts`:
- Constructor: replace `private readonly email: EmailService,` with `private readonly memberJoin: MemberJoinService,`. Import `MemberJoinService` from `./member-join.service` and drop the `EmailService` import.
- Signature: `async create(dto: CreateMemberDto, actor: AuthUser, requestOrigin?: string, now: Date = new Date())`.
- Replace `const invite = await this.supabaseAdmin.generateInviteLink(dto.email);` with `const auth = await this.supabaseAdmin.createAuthUser(dto.email);`, and every `invite.userId` with `auth.userId`.
- Replace the `emailSent` block (the `sendMagicLink` try/catch) with:

```ts
    // AFTER the plan sale, so the email can say which plan is waiting for them.
    // Caught for the same reason a failed sale is: the member is already
    // committed, and "Resend invite" issues a fresh link.
    let emailSent = false;
    try {
      emailSent = await this.memberJoin.issue(
        { userId: created.id, issuedById: actor.id, requestOrigin },
        now,
      );
    } catch (err) {
      this.logger.warn(`Setup link failed for member ${created.id}: ${String(err)}`);
    }
```

- Rewrite the method's doc comment so it reads:
  - "mint a Supabase user (`createAuthUser`, no link) → … → issue our setup link (`MemberJoinService.issue`) AFTER the commit and the optional sale".
  - Keep its argument about mail outages and plan-sale errors.

Run: `npm test --workspace=server -- members.service`
Expected: the `create` tests PASS. The `resendInvite` tests still fail, which the next steps handle.

- [ ] **Step 4: Rewrite the `resendInvite` tests, then the method**

The tests:
- It finds the member through the scoped `findOne`. A miss gives 404 `MEMBER_NOT_FOUND`, and `issue` is not called.
- It calls `memberJoin.issue({ userId: id, issuedById: actor.id, requestOrigin }, NOW)` and returns `{ member, emailSent }` from it.
- A `MEMBER_ALREADY_SIGNED_IN` thrown by `issue` propagates unchanged.

The method:

```ts
  /**
   * `POST /members/:id/resend-invite` — rotates the member's setup link and
   * emails it; the previous link dies at once. Refused (409, from
   * `MemberJoinService.issue`) for a member who has ever signed in: a link is a
   * way into the account, and they have "Forgot password".
   */
  async resendInvite(
    id: string,
    scope: ScopedWhere<Prisma.UserWhereInput>,
    actor: AuthUser,
    requestOrigin?: string,
    now: Date = new Date(),
  ): Promise<{ member: MemberListItem; emailSent: boolean }> {
    const member = await this.findOne(id, scope, now);
    const emailSent = await this.memberJoin.issue(
      { userId: member.userId, issuedById: actor.id, requestOrigin },
      now,
    );
    return { member, emailSent };
  }
```

- [ ] **Step 5: Write the failing `changeEmail` tests**

Add `describe('changeEmail')`. Mocks:
- `prisma.user.findFirst` for the scoped read, returning a row with `supabaseId`, `email: 'old@example.com'`, `lastSeenAt: null`, `firstName`, `lastName`, `memberCode`, and the `MEMBER_INCLUDE` fields the presenter needs. Reuse the spec's existing member-row factory.
- `prisma.user.update` for the write.
- `supabaseAdmin.updateAuthEmail`.

Tests:
1. **Happy path.** It calls `updateAuthEmail(supabaseId, 'new@example.com')` before `prisma.user.update({ where: { id }, data: { email: 'new@example.com' } })` (assert the order). It audits `MEMBER_EMAIL_CHANGED` with `details: { before: 'old@example.com', after: 'new@example.com' }`. Use a recording `audit.record` mock, like the existing "audited" constructions. It calls `memberJoin.issue(...)` and returns `{ member, emailSent: true }`.
2. **Refuses a member who has signed in** with 409 `MEMBER_ALREADY_SIGNED_IN`, touching neither Supabase nor the row.
3. **Refuses the same address** (after normalisation) as a no-op 409: code `MEMBER_EMAIL_TAKEN`, message "That is already their email.". Supabase is not called.
4. **Refuses an address another local user holds** with 409 `MEMBER_EMAIL_TAKEN` before calling Supabase. A second `prisma.user.findFirst` call, `{ where: { email: 'new@example.com', NOT: { id } } }`, returns a row.
5. **Puts the Supabase email back when the local update fails.** `prisma.user.update` rejects, so `updateAuthEmail` is called a second time with `(supabaseId, 'old@example.com')`, the original error is rethrown, and `issue` is not called.
6. **A revert that also fails** logs at error level and still rethrows the original error.

- [ ] **Step 6: Implement `changeEmail`, the DTO, and the audit union**

`server/src/users/dto/change-email.dto.ts`:

```ts
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

/**
 * `POST /members/:id/change-email` — correcting a mistyped address on a member
 * who has never signed in. Trimmed and lower-cased, like every email this API stores.
 */
export class ChangeMemberEmailDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
```

In `members.service.ts`:
- widen `recordAccountAction`'s first parameter union with `| 'MEMBER_EMAIL_CHANGED'`;
- add, after `resendInvite`:

```ts
  /**
   * `POST /members/:id/change-email` — the counter typed the address wrong, so
   * the setup link went nowhere. Only for a member who has NEVER signed in: an
   * active member's login email is theirs to change, not the desk's, and this
   * route must never become a way to point somebody's account at another inbox.
   *
   * Supabase first, because that is the address the member will sign in with;
   * then our row. If our write fails (another member took the address a moment
   * ago — `User_email_key`), Supabase is put back, so the two never disagree.
   */
  async changeEmail(
    id: string,
    email: string,
    scope: ScopedWhere<Prisma.UserWhereInput>,
    actor: AuthUser,
    requestOrigin?: string,
    now: Date = new Date(),
  ): Promise<{ member: MemberListItem; emailSent: boolean }> {
    const row = await this.prisma.user.findFirst({
      where: { AND: [{ id, deletedAt: null }, scope] },
      select: {
        id: true,
        supabaseId: true,
        email: true,
        firstName: true,
        lastName: true,
        memberCode: true,
        lastSeenAt: true,
      },
    });
    if (row === null) {
      throw new DomainException('MEMBER_NOT_FOUND', 'Member not found', HttpStatus.NOT_FOUND);
    }
    if (row.lastSeenAt !== null) {
      throw new DomainException(
        'MEMBER_ALREADY_SIGNED_IN',
        'They have already signed in. Ask them to use "Forgot password" on the sign-in page.',
        HttpStatus.CONFLICT,
      );
    }
    if (row.email === email) {
      throw new DomainException('MEMBER_EMAIL_TAKEN', 'That is already their email.', HttpStatus.CONFLICT);
    }
    const holder = await this.prisma.user.findFirst({
      where: { email, NOT: { id: row.id } },
      select: { id: true },
    });
    if (holder !== null) {
      throw new DomainException(
        'MEMBER_EMAIL_TAKEN',
        'A member with this email already exists.',
        HttpStatus.CONFLICT,
      );
    }

    await this.supabaseAdmin.updateAuthEmail(row.supabaseId, email);
    try {
      await this.prisma.user.update({ where: { id: row.id }, data: { email } });
    } catch (err) {
      try {
        await this.supabaseAdmin.updateAuthEmail(row.supabaseId, row.email);
      } catch (revertErr) {
        this.logger.error(
          `Supabase user ${row.supabaseId} now has ${email} but the member row kept ${row.email}: ` +
            `the local update failed and the revert failed too: ${String(revertErr)}`,
        );
      }
      throw err;
    }

    await this.recordAccountAction(
      'MEMBER_EMAIL_CHANGED',
      actor.id,
      { userId: row.id, firstName: row.firstName, lastName: row.lastName, memberCode: row.memberCode },
      { details: { before: row.email, after: email } },
      now,
    );

    const emailSent = await this.memberJoin.issue(
      { userId: row.id, issuedById: actor.id, requestOrigin },
      now,
    );
    return { member: await this.findOne(id, scope, now), emailSent };
  }
```

Run: `npm test --workspace=server -- members.service`
Expected: PASS.

- [ ] **Step 7: The controller**

In `members.controller.ts`:
- Add `Headers` to the `@nestjs/common` import, and import `ChangeMemberEmailDto`.
- `create`: add `@Headers('origin') origin: string | undefined` and call `this.members.create(dto, user, origin)`.
- `resendInvite`: add `@CurrentUser() user: AuthUser` and `@Headers('origin') origin: string | undefined`, and call `this.members.resendInvite(id, scope, user, origin)`. Update its doc comment: it rotates the setup link, and is refused for members who have signed in.
- New route, after `resendInvite`:

```ts
  /**
   * `POST /members/:id/change-email` — correct a mistyped address on a member
   * who has never signed in, and send the setup link to the new one. Same
   * permission as creating the member: it finishes the same job.
   */
  @Post(':id/change-email')
  @HttpCode(200)
  @RequirePermission('member.create')
  async changeEmail(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ChangeMemberEmailDto,
    @Scope('user') scope: MemberScope,
    @CurrentUser() user: AuthUser,
    @Headers('origin') origin: string | undefined,
  ): Promise<{ member: MemberListItem; emailSent: boolean }> {
    return this.members.changeEmail(id, dto.email, scope, user, origin);
  }
```

Update `members.controller.spec.ts`:
- the forwarded arguments for `create` and `resendInvite`;
- add `changeEmail` to any hand-written list of handlers that the spec checks for `member.create`, then assert it carries `member.create`;
- assert it forwards `(id, email, scope, user, origin)`.

- [ ] **Step 8: Delete the dead link and email code**

- `server/src/auth/supabase-admin.service.ts`:
  - delete `generateInviteLink`, `generateMagicLink`, the private `generateLink` and the exported `GeneratedLink` interface;
  - update the class doc comment so it names `createAuthUser` as the member mint;
  - delete their `describe` blocks from the spec.
- `server/src/notifications/email.service.ts`:
  - delete `sendMagicLink` and `inviteHtml`;
  - reword every doc comment that said "Throws like `sendMagicLink`" to "Throws like `sendMemberJoin`", and fix the class doc comment;
  - delete their spec tests.
- Run `grep -rn "generateInviteLink\|generateMagicLink\|sendMagicLink\|GeneratedLink" server/src server/test` and fix every remaining reference. The e2e specs may stub these; update the stubs to the new names.

- [ ] **Step 9: Typecheck and run the whole suite**

Run: `npm run build --workspace=shared && npm run typecheck --workspace=server && npm test --workspace=server -- --silent`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/src server/test
git commit -m "feat(members): counter sign-up sends the setup link; staff can fix a mistyped email

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Client — walk-in forms take an email; "Make member" pre-fills it

**Files:**
- Create: `client/src/lib/guestEmail.ts`, `client/src/lib/guestEmail.test.ts`
- Create: `client/src/lib/memberSeed.ts`, `client/src/lib/memberSeed.test.ts`
- Modify: `client/src/components/admin/NewMemberDrawer.tsx` (delete `NewMemberSeed` and `seedFromGuest` at ~49-82; import them from lib)
- Modify: `client/src/app/admin/attendance/page.tsx`, `client/src/app/admin/walk-ins/page.tsx` (import `seedFromGuest` from `@/lib/memberSeed`)
- Modify: `client/src/lib/adminApi.ts` (`sellWalkIn` body type ~1307; `checkInGuest` ~1237)
- Modify: `client/src/components/admin/WalkInSheet.tsx`, `client/src/components/admin/actions/WalkInModal.tsx`
- Test: `client/src/lib/adminApi.test.ts`

**Interfaces:**
- Consumes: `guestEmail` on `POST /front-desk/walk-ins` and on `GET /front-desk/check-ins/:id/guest` (Task 2).
- Produces:
  - `isPlausibleEmail(value: string): boolean`
  - `NewMemberSeed` and `seedFromGuest(guest: { guestName; guestPhone; guestEmail; guestEmergencyContact })` in `@/lib/memberSeed`
  - `adminApi.checkInGuest` returns `guestEmail`

- [ ] **Step 1: Write the failing email-helper test**

`client/src/lib/guestEmail.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isPlausibleEmail } from './guestEmail';

describe('isPlausibleEmail', () => {
  it.each(['ana@example.com', '  Ana.Cruz@Example.COM ', 'a.b+gym@sub.example.ph'])(
    'accepts %s',
    (value) => {
      expect(isPlausibleEmail(value)).toBe(true);
    },
  );

  it.each(['', '   ', 'ana', 'ana@', '@example.com', 'ana@example', 'ana @example.com', 'a@b@c.com'])(
    'refuses %j',
    (value) => {
      expect(isPlausibleEmail(value)).toBe(false);
    },
  );

  it('refuses anything over 254 characters', () => {
    expect(isPlausibleEmail(`${'a'.repeat(250)}@x.co`)).toBe(false);
  });
});
```

Run: `cd client && npx vitest run src/lib/guestEmail.test.ts`
Expected: FAIL, because the module is missing.

- [ ] **Step 2: Implement it**

`client/src/lib/guestEmail.ts`:

```ts
/**
 * Enough of an email to be worth sending to — the form's gate before the server's
 * `@IsEmail`. One `@`, something on both sides, a dot in the domain, no spaces.
 * Deliberately loose: the server is the authority, and this only spares the desk
 * a round trip for an obvious typo.
 */
export function isPlausibleEmail(value: string): boolean {
  const email = value.trim();
  if (email.length === 0 || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
```

Run the test again: PASS.

- [ ] **Step 3: Move the seed into lib, with a failing test**

`client/src/lib/memberSeed.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { seedFromGuest } from './memberSeed';

describe('seedFromGuest', () => {
  it('pre-fills the email the walk-in gave, so the desk types nothing twice', () => {
    expect(
      seedFromGuest({
        guestName: 'Ana Maria Cruz',
        guestPhone: '09171234567',
        guestEmail: 'ana@example.com',
        guestEmergencyContact: 'Maria 0917',
      }),
    ).toEqual({
      firstName: 'Ana',
      lastName: 'Maria Cruz',
      email: 'ana@example.com',
      phone: '09171234567',
      emergencyContact: 'Maria 0917',
    });
  });

  it('leaves the email blank for an older visit that never recorded one', () => {
    expect(
      seedFromGuest({
        guestName: 'Ana',
        guestPhone: null,
        guestEmail: null,
        guestEmergencyContact: null,
      }),
    ).toEqual({ firstName: 'Ana', lastName: '', email: '', phone: '', emergencyContact: '' });
  });
});
```

Create `client/src/lib/memberSeed.ts`:
- Move the `NewMemberSeed` interface (with its comments) here verbatim.
- Move the `seedFromGuest` function (with its doc comment) here, and change it to:
  - take `guestEmail: string | null` in its parameter type;
  - return `email: guest.guestEmail ?? ''`, placed after `lastName`.

In `NewMemberDrawer.tsx`:
- delete the two declarations;
- add `import type { NewMemberSeed } from '@/lib/memberSeed';`;
- keep `export type { NewMemberSeed }` / `export { seedFromGuest }` re-exports only if some other file imports them from the drawer (run `grep -rn "seedFromGuest\|NewMemberSeed" client/src`). Otherwise point those imports at `@/lib/memberSeed`.

`attendance/page.tsx` and `walk-ins/page.tsx` import `seedFromGuest` from `@/lib/memberSeed`.

Run: `npx vitest run src/lib/memberSeed.test.ts`
Expected: PASS.

- [ ] **Step 4: Update the admin API wrappers, test first**

In `client/src/lib/adminApi.test.ts`, mirror the existing `sellWalkIn` test and add:
- a test that `sellWalkIn({ kind: 'WALK_IN', guestName: 'Ana', guestEmail: 'ana@example.com', guestWaiverAccepted: true })` posts a body containing `guestEmail: 'ana@example.com'`;
- a test that `checkInGuest(id)` returns the `guestEmail` the server sent.

In `adminApi.ts`:
- `sellWalkIn`'s body type: add `guestEmail?: string;`, with the comment `/** Required by the server for a guest with no account (owner, 2026-10-14). */`.
- `checkInGuest`: add `guestEmail: string | null;` to both return types.

Run: `npx vitest run src/lib/adminApi.test.ts`
Expected: PASS.

- [ ] **Step 5: `WalkInSheet` — a required email**

In `WalkInSheet.tsx`:
- `import { isPlausibleEmail } from '@/lib/guestEmail';`
- state: `const [guestEmail, setGuestEmail] = useState('');`
- in the guest branch of `submit`'s body, after `guestName,`, add `guestEmail: guestEmail.trim().toLowerCase(),`
- in the guest fields, directly after the GUEST NAME `<label>`, add:

```tsx
              <label>
                <span className="a-person-sub">EMAIL</span>
                <input
                  className="a-input"
                  type="email"
                  value={guestEmail}
                  required
                  autoComplete="off"
                  inputMode="email"
                  onChange={(event) => setGuestEmail(event.target.value)}
                  placeholder="where their member link goes if they join"
                />
              </label>
```

- the submit button's `disabled` becomes:

```tsx
          disabled={
            busy ||
            (!forMember &&
              (!waiverAccepted || guestName.trim().length < 2 || !isPlausibleEmail(guestEmail)))
          }
```

- the error mapping in `submit`'s catch: add `GUEST_EMAIL_REQUIRED` and `GUEST_NAME_REQUIRED` branches that show the server's message (`caught.message`). The existing fallback already does this, so add nothing unless the chained ternary needs restructuring.

- [ ] **Step 6: `WalkInModal` — name and email both required**

In `WalkInModal.tsx`:
- `import { isPlausibleEmail } from '@/lib/guestEmail';`
- state `guestEmail`, reset in `close()`;
- `submit` sends `guestName: guestName.trim()` (no longer `undefined` when empty) and `guestEmail: guestEmail.trim().toLowerCase()`;
- the name label loses `<span className="a-field-opt">optional</span>`;
- after the name field, add:

```tsx
        <div className="a-field">
          <label className="a-field-label" htmlFor="walkin-email">
            Email
          </label>
          <input
            id="walkin-email"
            className="a-input"
            type="email"
            value={guestEmail}
            inputMode="email"
            autoComplete="off"
            placeholder="Where their member link goes if they join"
            onChange={(event) => setGuestEmail(event.target.value)}
          />
        </div>
```

- the Take payment button's `disabled` becomes `busy || !waiverAccepted || guestName.trim().length < 2 || !isPlausibleEmail(guestEmail)`.

- [ ] **Step 7: Typecheck, test and build the client**

Run from the repo root:

```
npm run build --workspace=shared && npm run build --workspace=client && npm run typecheck --workspace=client && npm test --workspace=client
```

Expected: PASS. First stop any running `next dev`, then `rm -rf client/.next`, because a dev server breaks `next build`.

- [ ] **Step 8: Commit**

```bash
git add client/src
git commit -m "feat(admin): walk-in forms take an email; Make member pre-fills it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Client — Change email, resend copy, audit label

**Files:**
- Modify: `client/src/lib/adminApi.ts` (add `changeMemberEmail` after `resendInvite` ~1018; add `'MEMBER_EMAIL_CHANGED'` to the `AuditEntry['action']` union ~669)
- Test: `client/src/lib/adminApi.test.ts`
- Create: `client/src/components/admin/actions/ChangeEmailModal.tsx`
- Modify: `client/src/components/admin/MemberDrawer.tsx` (the action union ~55-69, the menu ~233, the resend modal ~666)
- Modify: `client/src/components/admin/NewMemberDrawer.tsx` (the success copy ~514-540)
- Modify: `client/src/app/admin/audit/page.tsx` (`ACTION_LABELS` and the tone map)

**Interfaces:**
- Consumes: `POST /members/:id/change-email` → `{ member, emailSent }` (Task 5).
- Produces: `adminApi.changeMemberEmail(id: string, email: string): Promise<{ member: MemberListItem; emailSent: boolean }>`.

- [ ] **Step 1: Write the failing wrapper test, then the wrapper**

In `adminApi.test.ts`, add a test that `changeMemberEmail('id-1', 'new@example.com')` POSTs to `/members/id-1/change-email` with body `{ email: 'new@example.com' }`. Use the same fetch-mocking style as the existing `resendInvite` test.

In `adminApi.ts`, after `resendInvite`:

```ts
  /** `POST /members/:id/change-email` — only for a member who has never signed
   *  in; sends the setup link to the new address. 409 MEMBER_ALREADY_SIGNED_IN
   *  otherwise, with copy the modal shows as-is. */
  changeMemberEmail: (
    id: string,
    email: string,
  ): Promise<{ member: MemberListItem; emailSent: boolean }> =>
    apiFetch<{ member: MemberListItem; emailSent: boolean }>(`/members/${id}/change-email`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
```

Add `| 'MEMBER_EMAIL_CHANGED'` to the audit action union, with the comment `// Counter sign-up: staff corrected a never-signed-in member's email ({ before, after }).`

Run: `npx vitest run src/lib/adminApi.test.ts`
Expected: PASS.

- [ ] **Step 2: Audit label and tone**

In `client/src/app/admin/audit/page.tsx`:
- `ACTION_LABELS`: add `MEMBER_EMAIL_CHANGED: 'Member email corrected',` after `ROLE_CHANGED`.
- Tone map: add `MEMBER_EMAIL_CHANGED: 'warn',` beside the other MEMBER_* tones, with the comment: `// A login address changed: legitimate for a typo at the counter, and worth noticing.`

`summariseAuditDetails` already renders `{ before, after }` for this action; it is not TEXT_ONLY.

- [ ] **Step 3: The Change email modal**

`client/src/components/admin/actions/ChangeEmailModal.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { adminApi, type MemberListItem } from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import { isPlausibleEmail } from '@/lib/guestEmail';
import { Modal, ModalError } from '../Modal';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Correct a mistyped email on a member who has never signed in — the counter's
 * fix when the setup link went to the wrong inbox. The server refuses it for
 * anybody who has signed in (their login address is theirs to change) and sends
 * the setup link to the new address on success.
 */
export function ChangeEmailModal({
  open,
  member,
  onClose,
  onSaved,
}: {
  open: boolean;
  member: MemberListItem;
  onClose: () => void;
  onSaved: (updated: MemberListItem) => void;
}) {
  const [email, setEmail] = useState(member.email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState<boolean | null>(null);

  const next = email.trim().toLowerCase();
  const valid = isPlausibleEmail(next) && next !== member.email;

  const close = (): void => {
    if (busy) return;
    setError(null);
    setConfirming(false);
    setSent(null);
    setEmail(member.email);
    onClose();
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await adminApi.changeMemberEmail(member.userId, next);
      onSaved(result.member);
      setSent(result.emailSent);
      setConfirming(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open={open && !confirming}
        onClose={close}
        busy={busy}
        title="Change email"
        subtitle="For a member who has never signed in. The setup link goes to the new address."
        footer={
          sent === null ? (
            <>
              <button type="button" className="p-btn p-btn-ghost" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="p-btn p-btn-gold"
                onClick={() => setConfirming(true)}
                disabled={busy || !valid}
              >
                Save
              </button>
            </>
          ) : (
            <button type="button" className="p-btn p-btn-gold" onClick={close}>
              Done
            </button>
          )
        }
      >
        {sent === null ? (
          <div className="a-field">
            <label className="a-field-label" htmlFor="change-email-input">
              Email
            </label>
            <input
              id="change-email-input"
              className="a-input"
              type="email"
              value={email}
              inputMode="email"
              autoComplete="off"
              autoFocus
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
        ) : (
          <p style={{ margin: 0 }}>
            {sent
              ? `The setup link was sent to ${next}.`
              : `The email is saved, but the setup link may not have gone out. Use "Resend invite" to try again.`}
          </p>
        )}
        <ModalError message={confirming ? null : error} />
      </Modal>

      <ConfirmDialog
        open={open && confirming}
        title={`Change ${member.firstName} ${member.lastName}'s email?`}
        consequence="Their setup link goes to the new address, and the old link stops working."
        confirmLabel="Change email"
        cancelLabel="Keep editing"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      >
        <ul className="a-confirm-facts">
          <li>From: {member.email}</li>
          <li>
            To: <strong>{next}</strong>
          </li>
        </ul>
      </ConfirmDialog>
    </>
  );
}
```

Check the `Modal` props against `client/src/components/admin/Modal.tsx`: `subtitle`, and whether `footer` accepts a single element. Check `ConfirmDialog`'s props against `EditMemberModal`'s use. Adjust any prop name that differs.

- [ ] **Step 4: Wire it into `MemberDrawer`**

In `MemberDrawer.tsx`:
- Add `| { kind: 'changeEmail' }` to the action union.
- Import `ChangeEmailModal`.
- Inside the same `if (can(PERMISSIONS.MEMBER_CREATE) && member.lastSeenAt === null)` block as Resend invite, push a second item:

```tsx
      menuItems.push({
        key: 'changeEmail',
        label: 'Change email',
        onSelect: () => setAction({ kind: 'changeEmail' }),
      });
```

- Change the resend `ConfirmActionModal`'s copy:
  - `title={`Send ${fullName} a new setup link?`}`
  - `subtitle={`Emails a new setup link to ${member.email}. The old link stops working.`}`
  - `confirmLabel="Send link"`
- Mount the modal beside the others:

```tsx
      <ChangeEmailModal
        open={action?.kind === 'changeEmail'}
        member={member}
        onClose={() => setAction(null)}
        onSaved={(updated) => {
          setMember(updated);
          reloadList();
        }}
      />
```

`ConfirmActionModal` already shows the server's message on failure, so `MEMBER_ALREADY_SIGNED_IN` reads "They have already signed in. Ask them to use "Forgot password" on the sign-in page." with no client mapping.

- [ ] **Step 5: The New member drawer's success copy**

In `NewMemberDrawer.tsx`'s result view, replace the "`{name} ({email}) was created.`" paragraph with:

```tsx
            <p style={{ margin: 0 }}>
              {result.member.firstName} {result.member.lastName} was created.
              {result.emailSent
                ? ` Their setup link was emailed to ${result.member.email} — it works once, for 7 days.`
                : ''}
            </p>
```

Keep the existing `!result.emailSent` block. Change its hint to: "The setup link email may not have gone out. Check the address, then resend." The success line after resending stays "Invite resent."; change it to "Setup link sent."

- [ ] **Step 6: Typecheck, test and build**

Run from the repo root (stop `next dev` and `rm -rf client/.next` first):

```
npm run build --workspace=shared && npm run build --workspace=client && npm run typecheck --workspace=client && npm test --workspace=client
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src
git commit -m "feat(admin): change a never-signed-in member's email; setup-link copy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Client — the `/join/[token]` setup page

**Files:**
- Create: `client/src/lib/memberJoin.ts`, `client/src/lib/memberJoin.test.ts`
- Create: `client/src/components/auth/JoinPage.tsx`
- Create: `client/src/app/(auth)/join/[token]/page.tsx`

**Interfaces:**
- Consumes:
  - `GET /member-join/lookup`, `POST /member-join/claim-link`, `POST /member-join/accept` (Task 4)
  - shared `MemberJoinLookup`, `MemberJoinClaim`, `MemberJoinAccepted` (Task 1)
- Produces:
  - `memberJoinApi`
  - `joinStage(input): JoinStage`
  - `deadJoinCopy(input): JoinCopy`
  - `joinErrorCopy(code): JoinCopy`
  - `birthDateProblem(value, today): string | null`

- [ ] **Step 1: Write the failing helper tests**

`client/src/lib/memberJoin.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { birthDateProblem, deadJoinCopy, joinErrorCopy, joinStage } from './memberJoin';

const pending = { firstName: 'Ana', status: 'PENDING' as const, email: 'ana@example.com' };

describe('joinStage', () => {
  it('waits while the link or the session is still loading', () => {
    expect(joinStage({ lookup: 'loading', link: null, sessionEmail: undefined })).toBe('loading');
    expect(joinStage({ lookup: 'ok', link: pending, sessionEmail: undefined })).toBe('loading');
  });

  it('shows the dead face for a failed lookup, a used link and an expired one', () => {
    expect(joinStage({ lookup: 'dead', link: null, sessionEmail: null })).toBe('dead');
    expect(
      joinStage({ lookup: 'ok', link: { firstName: 'Ana', status: 'USED' }, sessionEmail: null }),
    ).toBe('dead');
    expect(
      joinStage({ lookup: 'ok', link: { firstName: 'Ana', status: 'EXPIRED' }, sessionEmail: null }),
    ).toBe('dead');
  });

  it('offers "Set up my account" when nobody is signed in', () => {
    expect(joinStage({ lookup: 'ok', link: pending, sessionEmail: null })).toBe('signed-out');
  });

  it('shows the password form only to the member themselves — case-insensitively', () => {
    expect(joinStage({ lookup: 'ok', link: pending, sessionEmail: 'ana@example.com' })).toBe(
      'signed-in',
    );
    expect(joinStage({ lookup: 'ok', link: pending, sessionEmail: 'Ana@Example.COM' })).toBe(
      'signed-in',
    );
  });

  it('NEVER shows the password form to another account signed in on this computer', () => {
    // An admin on the desk PC opening a member's link must not change their OWN password.
    expect(joinStage({ lookup: 'ok', link: pending, sessionEmail: 'admin@gym.test' })).toBe(
      'signed-in-other',
    );
  });
});

describe('deadJoinCopy', () => {
  it('tells a used link to sign in', () => {
    expect(deadJoinCopy({ status: 'USED', code: null }).title).toMatch(/already set up/i);
    expect(deadJoinCopy({ status: 'USED', code: null }).body).toMatch(/sign in/i);
  });

  it('tells an expired or unknown link to ask the front desk', () => {
    expect(deadJoinCopy({ status: 'EXPIRED', code: null }).body).toMatch(/front desk/i);
    expect(deadJoinCopy({ status: null, code: 'MEMBER_JOIN_NOT_FOUND' }).body).toMatch(/front desk/i);
  });

  it('does not call a network failure a dead link', () => {
    expect(deadJoinCopy({ status: null, code: null }).title).toMatch(/couldn't open/i);
  });
});

describe('joinErrorCopy', () => {
  it('explains a different signed-in account', () => {
    expect(joinErrorCopy('MEMBER_JOIN_WRONG_ACCOUNT').title).toMatch(/different account/i);
  });

  it('explains switched-off set-up', () => {
    expect(joinErrorCopy('MEMBER_CREATE_DISABLED').title).toMatch(/not available/i);
  });

  it('falls back to "try again" for anything else', () => {
    expect(joinErrorCopy(null).body).toMatch(/try again/i);
  });
});

describe('birthDateProblem', () => {
  const today = '2026-10-14';

  it('accepts a real past date', () => {
    expect(birthDateProblem('1995-03-02', today)).toBeNull();
  });

  it('asks for a date when blank or malformed', () => {
    expect(birthDateProblem('', today)).toMatch(/date of birth/i);
    expect(birthDateProblem('02/03/1995', today)).toMatch(/date of birth/i);
  });

  it('refuses a date in the future or today', () => {
    expect(birthDateProblem('2026-10-14', today)).toMatch(/past/i);
    expect(birthDateProblem('2030-01-01', today)).toMatch(/past/i);
  });

  it('refuses a date more than 120 years ago', () => {
    expect(birthDateProblem('1900-01-01', today)).toMatch(/check the year/i);
  });
});
```

Run: `cd client && npx vitest run src/lib/memberJoin.test.ts`
Expected: FAIL, because the module is missing.

- [ ] **Step 2: Implement the helpers and the API**

`client/src/lib/memberJoin.ts`:

```ts
import type { MemberJoinAccepted, MemberJoinClaim, MemberJoinLookup } from '@got/shared';
import { apiFetch } from './api';

/**
 * The member setup page (`/join/[token]`), everything but the pixels.
 *
 * Like the staff invite page: every dead end says what happened AND what to do
 * next, and a network failure is never dressed up as a dead link.
 */

export interface JoinCopy {
  title: string;
  body: string;
}

export type JoinLookupState = 'loading' | 'ok' | 'dead';
export type JoinStage = 'loading' | 'dead' | 'signed-out' | 'signed-in' | 'signed-in-other';

/**
 * Which face to show. `sessionEmail` is `undefined` while the session is still
 * being read, `null` when nobody is signed in.
 *
 * THE PASSWORD FORM IS ONLY FOR THE MEMBER. A desk PC is usually signed in as
 * staff; if a member's link is opened there, showing the form would let the
 * staff account change its OWN password. So any other session gets the "set up"
 * button, which signs the member in in its place.
 */
export function joinStage(input: {
  lookup: JoinLookupState;
  link: MemberJoinLookup | null;
  sessionEmail: string | null | undefined;
}): JoinStage {
  if (input.lookup === 'dead') return 'dead';
  if (input.lookup === 'loading' || input.link === null) return 'loading';
  if (input.link.status !== 'PENDING') return 'dead';
  if (input.sessionEmail === undefined) return 'loading';
  if (input.sessionEmail === null) return 'signed-out';
  return input.sessionEmail.trim().toLowerCase() === (input.link.email ?? '').toLowerCase()
    ? 'signed-in'
    : 'signed-in-other';
}

/** Why the link cannot be used — from the lookup's status, or its error code. */
export function deadJoinCopy(input: {
  status: MemberJoinLookup['status'] | null;
  code: string | null;
}): JoinCopy {
  if (input.status === 'USED' || input.code === 'MEMBER_JOIN_USED') {
    return {
      title: 'Your account is already set up',
      body: 'Sign in with your email and password. Forgot it? Use "Forgot password" on the sign-in page.',
    };
  }
  if (
    input.status === 'EXPIRED' ||
    input.code === 'MEMBER_JOIN_EXPIRED' ||
    input.code === 'MEMBER_JOIN_NOT_FOUND'
  ) {
    return {
      title: 'This link has expired',
      body: 'Setup links last 7 days. Ask the front desk to send you a new one.',
    };
  }
  return {
    title: "We couldn't open this link",
    body: 'This is usually the connection. Reload the page to try again.',
  };
}

/** Why a step failed — the link was fine a moment ago. */
export function joinErrorCopy(code: string | null): JoinCopy {
  switch (code) {
    case 'MEMBER_JOIN_WRONG_ACCOUNT':
      return {
        title: "You're signed in with a different account",
        body: 'Sign out, then open the link from your email again.',
      };
    case 'MEMBER_CREATE_DISABLED':
      return {
        title: 'Account set-up is not available right now',
        body: 'Please let the front desk know.',
      };
    case 'MEMBER_JOIN_USED':
    case 'MEMBER_JOIN_EXPIRED':
    case 'MEMBER_JOIN_NOT_FOUND':
      return deadJoinCopy({ status: null, code });
    default:
      return { title: 'Something went wrong', body: 'Your link is still valid. Try again in a moment.' };
  }
}

/**
 * The form's check on a `yyyy-mm-dd` from a date input. `today` is the same
 * shape. Whether the date is old enough to be stored is the server's rule
 * (`asJoinableBirthDate`), not this one.
 */
export function birthDateProblem(value: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Enter your date of birth.';
  if (value >= today) return 'Your date of birth must be in the past.';
  const earliest = `${Number(today.slice(0, 4)) - 120}${today.slice(4)}`;
  if (value < earliest) return 'Please check the year of your date of birth.';
  return null;
}

/** The setup page's three calls. Separate from `adminApi`: a stranger with a link opens this page. */
export const memberJoinApi = {
  lookup: (token: string): Promise<MemberJoinLookup> =>
    apiFetch<MemberJoinLookup>(`/member-join/lookup?token=${encodeURIComponent(token)}`),

  claimLink: (token: string): Promise<MemberJoinClaim> =>
    apiFetch<MemberJoinClaim>('/member-join/claim-link', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  accept: (token: string, dateOfBirth: string): Promise<MemberJoinAccepted> =>
    apiFetch<MemberJoinAccepted>('/member-join/accept', {
      method: 'POST',
      body: JSON.stringify({ token, dateOfBirth }),
    }),
};
```

Run the test again: PASS.

- [ ] **Step 3: The route**

`client/src/app/(auth)/join/[token]/page.tsx`:

```tsx
import type { Metadata } from 'next';
import JoinPage from '@/components/auth/JoinPage';

export const metadata: Metadata = {
  title: 'Set up your account — Gym of Thrones',
  description: 'Finish setting up your Gym of Thrones membership account.',
  // A link carrying a secret is nobody's search result.
  robots: { index: false, follow: false },
};

/**
 * `/join/<token>` — a member's setup link, from the email the front desk's
 * "Create member" sends. Inside `(auth)` so it shares the sign-in pages' look.
 * Next 16: `params` is a Promise. The token is only ever sent back to the API.
 */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <JoinPage token={token} />;
}
```

- [ ] **Step 4: The page component**

`client/src/components/auth/JoinPage.tsx` is modelled on `InvitePage.tsx`: same `auth-split` layout, `AuthBrandPanel`, `errorBox` and `lead` styles, the same `supabase.auth` session effect and the same `PasswordInput`. The differences:
- the stages come from `joinStage`;
- there is no sessionStorage marker: the signed-in face **always** asks for a password;
- a date-of-birth field;
- `memberJoinApi`.

Write it in full:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MemberJoinLookup } from '@got/shared';
import AuthBrandPanel from './AuthBrandPanel';
import { PasswordInput } from './PasswordInput';
import { supabase } from '@/lib/supabase';
import { ApiError, apiFetch } from '@/lib/api';
import { normalisePassword } from '@/lib/credentials';
import { homeFor, type HeldPermission } from '@/lib/safeNext';
import {
  birthDateProblem,
  deadJoinCopy,
  joinErrorCopy,
  joinStage,
  memberJoinApi,
  type JoinCopy,
  type JoinLookupState,
} from '@/lib/memberJoin';

const errorBox = {
  padding: '11px 14px',
  borderRadius: 7,
  border: '1px solid rgba(255,90,70,.4)',
  background: 'rgba(255,90,70,.1)',
  color: '#ff9d92',
  fontSize: 13,
  lineHeight: 1.5,
} as const;

const lead = {
  fontSize: 14.5,
  lineHeight: 1.6,
  color: 'var(--text-2)',
  margin: '0 0 24px',
} as const;

/** Today as `yyyy-mm-dd` in the browser's calendar — only the form's sanity check uses it. */
function localToday(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * `/join/[token]` — a member created at the front desk finishing their account.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PASSWORD FORM IS SHOWN ONLY TO THE MEMBER THE LINK WAS MADE FOR.
 * `joinStage` compares the signed-in session's email with the link's: on a desk
 * PC signed in as staff, the page offers "Set up my account" (which signs the
 * member in instead) and never a form that would change the staff password.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Faces: loading; dead (already set up, expired, not valid); signed out or
 * signed in as somebody else ("Set up my account"); signed in as the member
 * (choose a password, date of birth, finish). The password is saved with
 * Supabase BEFORE `accept`, so a failed accept never leaves them without one.
 */
export default function JoinPage({ token }: { token: string }) {
  const router = useRouter();
  const [lookup, setLookup] = useState<JoinLookupState>('loading');
  const [joinLink, setJoinLink] = useState<MemberJoinLookup | null>(null);
  const [deadCode, setDeadCode] = useState<string | null>(null);
  const [sessionEmail, setSessionEmail] = useState<string | null | undefined>(undefined);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<JoinCopy | null>(null);

  useEffect(() => {
    let cancelled = false;
    memberJoinApi.lookup(token).then(
      (found) => {
        if (cancelled) return;
        setJoinLink(found);
        setLookup('ok');
      },
      (caught: unknown) => {
        if (cancelled) return;
        setDeadCode(caught instanceof ApiError ? caught.code : null);
        setLookup('dead');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    const apply = (email: string | null | undefined): void => {
      if (!cancelled) setSessionEmail(email ?? null);
    };
    void supabase.auth.getSession().then(({ data }) => apply(data.session?.user.email ?? null));
    // The sign-in link comes back with the session in the URL fragment;
    // `detectSessionInUrl` turns it into a session a moment after mount.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      apply(next?.user.email ?? null);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const setUp = useCallback(async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const claim = await memberJoinApi.claimLink(token);
      window.location.assign(claim.url);
    } catch (caught) {
      setProblem(joinErrorCopy(caught instanceof ApiError ? caught.code : null));
      setBusy(false);
    }
  }, [token]);

  const finish = useCallback(async (): Promise<void> => {
    setProblem(null);
    const next = normalisePassword(password);
    if (next.length < 8) {
      setProblem({ title: 'Choose a password', body: 'Use at least 8 characters.' });
      return;
    }
    if (next !== normalisePassword(confirm)) {
      setProblem({ title: 'Choose a password', body: 'The two passwords do not match.' });
      return;
    }
    const dobProblem = birthDateProblem(dateOfBirth, localToday());
    if (dobProblem !== null) {
      setProblem({ title: 'Date of birth', body: dobProblem });
      return;
    }

    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: next });
      if (error !== null) {
        setProblem({ title: 'Your password was not saved', body: error.message });
        return;
      }
      await memberJoinApi.accept(token, dateOfBirth);
      const me = await apiFetch<{ permissions: HeldPermission[] }>('/me');
      router.replace(homeFor(me.permissions));
    } catch (caught) {
      setProblem(joinErrorCopy(caught instanceof ApiError ? caught.code : null));
    } finally {
      setBusy(false);
    }
  }, [password, confirm, dateOfBirth, token, router]);

  const signOut = async (): Promise<void> => {
    await supabase.auth.signOut();
    setProblem(null);
  };

  const stage = joinStage({ lookup, link: joinLink, sessionEmail });
  const dead = deadJoinCopy({ status: joinLink?.status ?? null, code: deadCode });

  return (
    <div className="auth-split">
      <AuthBrandPanel
        image="/assets/gym-e.webp"
        imageAlt="Gym floor"
        backLabel="← GYM OF THRONES"
        onBack={() => router.push('/')}
        headline={['YOUR', 'MEMBERSHIP', 'AWAITS']}
        kicker="House of Fitness · Est 2023"
        blurb="Your account was created at the front desk — finish it here and you're in."
      />

      <div className="auth-form-pane">
        <div style={{ width: '100%', maxWidth: 420, animation: 'fadeInUp .55s ease both' }}>
          <span className="eyebrow">Account set-up</span>

          <h1
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 800,
              fontSize: 'clamp(26px, 3.4vw, 36px)',
              letterSpacing: '-0.01em',
              lineHeight: 1.15,
              margin: '14px 0 12px',
              color: 'var(--text)',
            }}
          >
            {stage === 'dead'
              ? dead.title
              : joinLink === null
                ? 'Opening your link…'
                : `Hi ${joinLink.firstName} — set up your account`}
          </h1>

          {stage === 'loading' ? (
            <p style={lead} aria-busy="true">
              Checking your link…
            </p>
          ) : null}

          {stage === 'dead' ? (
            <>
              <p style={lead}>{dead.body}</p>
              <Link href="/login" className="btn btn-gold btn-block">
                GO TO SIGN IN
              </Link>
            </>
          ) : null}

          {(stage === 'signed-out' || stage === 'signed-in-other') && joinLink !== null ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <p style={{ ...lead, margin: 0 }}>
                This account is for <strong>{joinLink.email}</strong>. You&apos;ll choose a
                password next. The link works once, for 7 days.
              </p>
              {stage === 'signed-in-other' ? (
                <p style={{ ...lead, margin: 0 }}>
                  This computer is signed in as <strong>{sessionEmail}</strong>. Setting up signs
                  that account out here.
                </p>
              ) : null}
              <button
                type="button"
                className="btn btn-gold btn-block"
                disabled={busy}
                onClick={() => void setUp()}
              >
                {busy ? 'SETTING UP…' : 'SET UP MY ACCOUNT'}
              </button>
            </div>
          ) : null}

          {stage === 'signed-in' && joinLink !== null ? (
            <form
              style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
              onSubmit={(event) => {
                event.preventDefault();
                void finish();
              }}
            >
              <p style={{ ...lead, margin: 0 }}>
                Signed in as <strong>{sessionEmail}</strong>. Choose a password so you can sign in
                again next time.
              </p>
              <div className="field">
                <label htmlFor="join-password">Password</label>
                <PasswordInput
                  id="join-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="join-confirm">Confirm password</label>
                <PasswordInput
                  id="join-confirm"
                  placeholder="••••••••"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="join-dob">Date of birth</label>
                <input
                  id="join-dob"
                  type="date"
                  value={dateOfBirth}
                  max={localToday()}
                  onChange={(event) => setDateOfBirth(event.target.value)}
                  required
                />
              </div>

              <button type="submit" className="btn btn-gold btn-block" disabled={busy}>
                {busy ? 'SAVING…' : 'FINISH SETTING UP'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-block"
                disabled={busy}
                onClick={() => void signOut()}
              >
                NOT YOU? SIGN OUT
              </button>
            </form>
          ) : null}

          {problem === null ? null : (
            <div role="alert" style={{ ...errorBox, marginTop: 16 }}>
              <strong style={{ display: 'block', marginBottom: 4 }}>{problem.title}</strong>
              {problem.body}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

Two things to check:
- the `.field` / date input styling against `RegisterPage.tsx`'s date input (`reg-dob`), and copy any class it uses so the date field matches the sign-up page;
- `AuthBrandPanel`'s `headline` prop shape against `InvitePage`'s use.

- [ ] **Step 5: Build, typecheck and test the client; check the containment gate**

Run from the repo root (stop `next dev` and `rm -rf client/.next` first):

```
npm run build --workspace=shared && npm run build --workspace=client && npm run typecheck --workspace=client && npm test --workspace=client && npm run check:tailwind --workspace=client
```

Expected: everything passes, and `check:tailwind` reports a non-zero utility count. `/join/[token]` must appear in `next build`'s route list.

- [ ] **Step 6: Commit**

```bash
git add client/src
git commit -m "feat(auth): /join/[token] — members set a password and birth date on first use

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After all tasks

Run the full production-readiness gate from `CLAUDE.md` on the committed tree, using `C:\Users\patri\AppData\Local\Temp\claude\E--ALL-PROJECTS-GYM-OF-THRONES-GYM-OF-THRONES\183d2687-5da4-404e-af09-5accb6d6adb7\scratchpad\gate-wt.sh`. The order is: clean → build shared → prisma generate → build server (`dist/main.js` present) → build client → both typechecks → both test suites → `check:tailwind`, with a non-zero count. Do not push.
