# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Branch workflow — NEVER push to main

**`main` auto-deploys to production (Render for the API, Vercel for the client). We are in development.**

Render redeploys only when something the API is built from changes — `server/`, `shared/`, or the root `package.json`, `package-lock.json` and `.nvmrc` (`buildFilter` in `render.yaml`). Client-only, docs and `ops/` pushes rebuild Vercel but do not restart the API. Every Render deploy runs `prisma migrate deploy && prisma db seed` in its build.

- ALL work happens on a feature branch (`feat/<name>`), pushed to origin as a branch.
- NEVER commit to or push `main` — not for features, not for fixes, not for docs —
  unless the owner explicitly says "push to main" / "merge to main" for that
  specific change, in that conversation.
- Database migrations count double: `main`'s code and the shared database must
  stay compatible, so a migration ships only when its branch merges — never
  applied to the live database while `main` still runs the old code.

## Project

Gym of Thrones House of Fitness. npm-workspaces monorepo: `client/` (Next.js 16 App Router) + `server/` (NestJS 11 + Prisma/Supabase Postgres) + `shared/` (types & constants consumed by both). Prisma, Health, Auth, Users, RBAC, Membership, Payments, Check-in, Front-desk and Announcements are wired up in `server/src/app.module.ts`; `ServicesModule` and `ContactModule` are still commented out and get added one phase at a time (see README's module-ownership table).

## Commands

Run from the repo root unless noted.

```bash
npm install                          # installs all three workspaces
npm run dev:server                   # NestJS watch mode → http://localhost:4000
npm run dev:client                   # Next.js → http://localhost:3000
npm run build                        # shared → server → client, in that order
npm run build:server                 # or: npm run build:client
npm run lint                         # per-workspace lint (server's script auto-fixes: eslint --fix)
npm run format                       # prettier over the whole repo
npm run typecheck --workspace=client # or --workspace=shared

# server/ only
npm test --workspace=server                      # jest unit (*.spec.ts under src/)
npm test --workspace=server -- health.controller # single test file by path pattern
npm run test:watch --workspace=server
npm run test:e2e --workspace=server              # test/*.e2e-spec.ts
npx prisma generate                              # run inside server/
npx prisma migrate dev --name <name>
npm run db:seed --workspace=server               # permission catalogue + role grants
npm run seed:accounts --workspace=server         # one personal test account per role
```

`prisma db seed` is required after every `migrate dev`/`migrate deploy` — it loads the permission catalogue and role grants from `server/src/rbac/permission-registry.ts`. Skipping it leaves every non-`DEV` role with zero permissions and fails closed silently: `/admin/permissions` 403s even for an ADMIN and `/me` returns `permissions: []`, with no crash to point at the cause.

Health check: `GET http://localhost:4000/api/health` (version-neutral). All other routes live under `/api/v1`.

## Production-readiness gate — run this before every push

**Never push, and never claim work is done, without these passing.** "It compiled in dev" is not evidence: `next dev` and `nest start --watch` are incremental and forgiving in ways a deploy container is not.

**STOP `next dev` AND `nest start --watch` FIRST.** Not optional — see the trap below.

**Order matters: clean → build → typecheck.** Both typechecks depend on build output, so running them first against a cleaned tree produces a screenful of errors that mean nothing.

```bash
# 0. Kill the dev servers. `next build` and `next dev` share client/.next.
# 1. Clean every artifact that can silently go stale.
rm -rf client/.next shared/dist server/dist server/tsconfig.build.tsbuildinfo

# 2. Build, exactly as the platforms do.
npm run build --workspace=shared && npm run prisma:generate --workspace=server \
  && npm run build --workspace=server                                           # Render
ls server/dist/main.js                                                          # must exist
npm run build --workspace=shared && npm run build --workspace=client            # Vercel

# 3. Only now typecheck, and test.
npm run typecheck --workspace=server
npm run typecheck --workspace=client
npm test --workspace=server
```

**`next build` fails while `next dev` is running.** The dev server writes `client/.next/dev/types/*`, and `next build`'s type-check pass reads them and dies on files it did not generate:

```
.next/dev/types/routes.d.ts(66,2): error TS1128: Declaration or statement expected.
.next/dev/types/validator.ts(134,69): error TS1005: '?' expected.
Failed to type check.
```

Nothing is wrong with your code. Stop `next dev`, `rm -rf client/.next`, rebuild. This is a **local-only** failure — Vercel has no dev server — but it will convince you that you have broken the build, and it comes and goes with timing, so the same command can pass twice and then fail.

**Typecheck AFTER building, never before.** `npm run typecheck --workspace=server` resolves `@got/shared` through the package's `main`/`types`, which point at `shared/dist` — so on a cleaned tree it reports `Cannot find module '@got/shared'` in every file that imports it, including files you never touched. The client is the same story with `.next/types`, which is why the "known rough edge" below says to build or run dev at least once first. Neither is a real error; both are the gate run in the wrong order.

**Verify from the COMMITTED state, not the working tree.** `git status` must show nothing unexpected before you build. A green build over uncommitted files proves nothing about what you actually pushed — and if you leave someone else's unrelated change in the tree, say so rather than committing it silently.

**Delete `server/tsconfig.build.tsbuildinfo` first.** `nest build` is incremental and silently exits 0 producing no output when that file is newer than a deleted `dist/`. A build that emits nothing looks identical to a build that succeeded. Checking `server/dist/main.js` exists is the assertion that catches it.

**Delete `shared/dist` first.** It is gitignored, so your machine has a copy the deploy container does not. A stale one hides a missing export from `@got/shared` until the deploy fails with `MODULE_NOT_FOUND` — and both platform build commands rebuild shared first precisely because of this.

**Do NOT run `npm run lint` as part of the gate.** Two reasons, both live today:
- `server/package.json`'s lint script is `eslint --fix`, so **running it rewrites source files**, including files your change never touched. It has silently modified committed work mid-session.
- Both workspaces currently fail lint on **pre-existing** errors (`server/src/auth`, `server/src/me`, `common/exceptions/*.spec.ts`; `client/src/app/admin/stations/page.tsx:313,339`). Until those are cleaned up, a lint gate cannot go green, so treat lint as a manual, per-file check: run it, read the output for **the files you changed**, and never commit its `--fix` edits to unrelated files.

**What this gate cannot catch, so never claim it did.** A green local build says nothing about: env vars missing on the platform (`env.validation.ts` deliberately crashes the process at boot), database reachability (`P1001` — the pooler drops connections; `prisma.service.ts` retries transport failures at boot via `connect-with-retry.ts`, but a sustained outage still fails the healthcheck), the platform's healthcheck window, or `NEXT_PUBLIC_*` values, which are baked into the browser bundle **at build time** and need a rebuild rather than a restart. When a deploy fails, read the platform log before proposing a cause — `docs/deploy.md` §"When the build fails" maps the common log lines to their real causes.

## Architecture

**Request/response envelope.** Controllers return plain data; `TransformInterceptor` wraps every success in `{ success: true, data }` and `HttpExceptionFilter` renders every failure as `{ success: false, error: { code, message } }`. Both are registered globally in `server/src/main.ts` and typed against `ApiSuccessResponse`/`ApiErrorResponse` in `shared/src/types/api.types.ts` — so the client can rely on that shape without per-endpoint types. Non-`HttpException` throws are logged in full server-side and reported to the client as a bare `INTERNAL_SERVER_ERROR`; keep it that way.

**Global pipeline in `main.ts`.** helmet → global prefix `api` + URI versioning (default `1`) → CORS from `CORS_ORIGIN` (comma-separated) → `ValidationPipe` with `whitelist` + `forbidNonWhitelisted` + `transform`. Because unknown body properties are rejected outright, every endpoint needs a class-validator DTO or requests will 400.

**Env validation.** `server/src/config/env.validation.ts` parses env with zod at startup and throws if anything is missing — deliberately crash-on-misconfiguration. Adding a required env var means adding it to that schema, the root `.env.example`, and your local `.env`. The gym's operating parameters (time zone, opening hours, grace and freeze windows, station-token slot and batch size, idempotency retention, `SCHEDULER_ENABLED`) all live there and are read through `GymConfigService` in `server/src/config/gym.config.ts`, which deliberately exposes no secret. `GYM_TIMEZONE` is validated by construction, so IANA aliases such as `Asia/Calcutta` are accepted while `Asia/Manilla` crashes the boot.

**Attendance, and the two rules that surround it.** `POST /api/v1/checkin` is the member's own scan and returns **200 in every business outcome, including every denial** — `client/src/lib/api.ts` throws on `!body.success`, so a denial thrown as a 4xx reaches a member's phone as a bare `Error` with no reason and no next step. It is also **the only route in the system exempt from `Idempotency-Key`**: `StationScan @@unique([userId, stationId, slot])` is that route's key and is strictly stronger, and honouring both would give two idempotency mechanisms that can disagree. Inside `prisma.$transaction`, **never catch a unique violation and then issue another statement on the same `tx`** — Postgres aborts the transaction on the first statement error and Prisma issues no per-statement `SAVEPOINT`, so the follow-up dies with `25P02`. Use `createMany({ skipDuplicates: true })` and branch on `count === 0`.

**`DeskMember` is a privacy boundary, not a convenience type.** Everything the front-desk console shows goes through it (`server/src/front-desk/desk.presenter.ts`). That projection streams continuously to a PC in a public lobby and stays on screen all day, so the test for adding a field is not "would the desk find it useful" but "is it worth a stranger reading it over the counter". Phone, email, address, payment history and body metrics are deliberately absent; `avatarUrl` is in because recognising a denied member in a room of thirty is the photo's highest-value use.

**Two named rate-limit buckets.** `default` is keyed on the authenticated user (`UserThrottlerGuard`, falling back to IP on `@Public()` routes and to the station key on the display's routes) and bounds one account's retries. `origin` is keyed on the source IP, exempts `GYM_EGRESS_CIDRS`, and exists for the one threat the per-user bucket cannot see: a relay is N accounts submitting once each. Both are declared in `app.module.ts`; `POST /checkin` tightens `origin` to 60/60s with `@Throttle`.

**Two database URLs, and one required query string.** Supabase issues a pooled and a direct connection string and both are required: `DATABASE_URL` (transaction pooler, port 6543) is what the app uses at runtime, `DIRECT_URL` (session, port 5432) is what `prisma migrate` uses because migrations cannot run through the pooler. `schema.prisma` references both; omitting `DIRECT_URL` fails every prisma command with P1012. **`DATABASE_URL` must carry `?pgbouncer=true` and an explicit `connection_limit`.** Without them, interactive transactions intermittently fail with *"prepared statement s0 already exists"* under concurrency — which presents as random 500s on unrelated endpoints rather than as a configuration problem, and is close to undiagnosable from the symptom.

**Shared package has a real build.** `@got/shared` compiles with `tsc` (`npm run build --workspace=shared`) to `shared/dist/`, and `package.json` `main`/`types`/`exports` point there — so server code may import *runtime values* (`UserRole`, `MembershipStatus`, `API_ROUTES`, `PAGINATION_DEFAULTS`) from it, not just types. `shared/dist/` is gitignored and not rebuilt by `build:server` alone, so run the root `npm run build` (which builds shared → server → client in order) or build shared first; a stale or missing `dist/` is what a runtime `MODULE_NOT_FOUND` on `@got/shared` means. The client resolves it through the `@got/shared` path mapping in `client/tsconfig.json` and bundles the source directly; server jest maps it to `shared/src/index.ts` the same way, so tests never need `dist/`.

**Prisma schema is folder-based.** `server/package.json` sets `prisma.schema = "prisma/schema"`. `schema.prisma` holds only generator + datasource; each model goes in its own `.prisma` file in that directory.

**Three surfaces, one design system.** `client/src/app/portal.css` owns every token, card, table, badge and button. The member portal is `.portal-root`; the **Admin CRM** is `.portal-root .admin-root` (`admin.css` adds only the CRM-specific pieces — KPI row, filter toolbar, pager, denial rail); the **desk surfaces** (`/desk/station`) are `.desk-root` in `desk.css`, dark, and deliberately separate because a mounted lobby panel has no user, no session and no navigation. Gold tokens come from `globals.css` in all three, which is what makes them read as one product. Do not start a fourth.

**Tailwind v4 + shadcn/ui, contained (since 2026-09-13).** The owner chose shadcn/ui for the member portal's schedule, bookings and calendar screens. It does not replace the token system; it sits on it. The rules: `src/app/tailwind.css` is imported by `app/portal/layout.tsx` only; it imports `tailwindcss/theme.css` and `tailwindcss/utilities.css` and **never** `tailwindcss` (that is Preflight, which would restyle every existing screen); `source(none)` plus explicit `@source` lines limit generation to `components/ui`, `components/schedule` and the portal pages rebuilt on it; shadcn's variables under `.portal-root` map to the gold/paper tokens and never carry their own hex. After `next build`, `npm run check:tailwind --workspace=client` must pass **with a non-zero utility count** — it fails if any legacy className matches a generated utility, and an exit code of 2 ("no utilities found") means the gate did not run and must be fixed, not ignored. New Tailwind-based files go in a scanned folder, and a new scanned folder needs an `@source` line and an entry in `scripts/tailwind-containment.mjs`.

**The CRM shows nothing it cannot source.** Every tile, column and toggle on `/admin` is backed by a real endpoint, or it is cut and named as missing. A dashboard that mixes live figures with plausible-looking placeholders is worse than a smaller one — staff cannot tell which is which, and the first time somebody acts on a fake number the whole screen loses its credibility. The CRM nav is built from the caller's own `permissions` from `GET /me`, never from their role: a role test would hard-code today's grant table into the client and silently stop agreeing with it the first time a grant is edited. Hiding a link is not a security control; every route behind one is permission-checked server-side.

**Design reference.** The exported HTML mockups of the three surfaces — `Gym of Thrones.dc.html` (public site), `Member Portal.dc.html`, `Admin CRM.dc.html` — plus the real gym photos live in `screenshots/reference/` in the **parent** directory, one level above this repo (`../screenshots/`). They are deliberately kept outside version control. Use them as the visual spec for UI work.

## Auth & RBAC

Full design: `docs/superpowers/specs/2026-08-16-rbac-auth-design.md`. It ships in additive phases (see its §0 table); each phase's task-by-task plan lives alongside it in `docs/superpowers/plans/`.

- **Phase 1 — done.** Supabase Auth issues the JWTs; NestJS verifies them locally against Supabase's JWKS (no per-request network call). `AuthGuard` is global (`@Public()` opts out), just-in-time provisioning creates the local `User` row on first sight, `GET /me` returns the caller's own profile. Client `LoginPage`/`RegisterPage` call `supabase.auth.signInWithPassword`/`signUp` directly — this API never issues or validates passwords itself.
- **Phase 2 — permissions.** `Permission` / `RolePermission` tables, `PermissionsGuard`, `@RequirePermission`, version-keyed cache, seeded catalogue. Endpoints become role-gated.
- **Phase 3 — scoping.** `UserPermission` overrides, `PermissionScope` (`OWN`/`ALL`), `CoachAssignment`.
- **Phase 4 — admin.** Admin user/permission/role API, `AuditLog`.
- **Phase 5 — check-in.** QR-based member check-in.
- **Sign-in code (2026-10-15).** After the password, every sign-in enters a 6-digit code our API emails through Resend (`docs/superpowers/specs/2026-10-15-login-code-design.md`). `LoginGateService` is the one decision point — `AuthGuard` and `StationTokenAccessGuard`'s staff path both call it — and an unverified sign-in gets `401 LOGIN_CODE_REQUIRED` on every authenticated route except the two `@AllowUnverifiedLogin()` routes, `POST /auth/login-code` and `POST /auth/login-code/verify`. Verified means a `LoginVerification` row with `verifiedAt` for the token's `session_id`, or an email-link `amr` (`otp`, `magiclink`, `invite`, `recovery`), or `LOGIN_CODE_REQUIRED=false`. That env var (default `true`) is the **kill switch** when email breaks: set it `false` and restart. Live chat applies the same rule in SQL (`public.login_session_verified()` in the Realtime policy), reading the switch from the one-row `LoginCodeSetting` the API writes at boot. A token without `session_id` is refused. The e2e harness defaults the switch to `false` (`test/support/db.ts`).
- **One device at a time (2026-10-30).** Every account, staff included, may use the API from one device. `User.activeSessionId` / `activeSessionSignedInAt` name the sign-in that holds the account; a sign-in's time is its latest `amr` timestamp, not `iat`, because every refreshed token gets a new `iat` and an old laptop would look new. `SingleSessionService.assertCurrent` is the one decision point, called by `AuthGuard` AFTER `LoginGateService` (and skipped on the two `@AllowUnverifiedLogin()` routes) and by `StationTokenAccessGuard`'s staff path: only a verified sign-in can claim, so a stolen password still waiting for its code never signs the owner out. The holder passes with no write (its row comes from provisioning's existing per-request read, kept out of `AuthUser`); a newer sign-in takes over with a conditional `updateMany`; an older one gets `401 SESSION_REPLACED`. The client (`lib/sessionReplaced.ts`, called by `apiFetch`) answers that with a **local** sign-out, never a global one, which would also end the new device's sign-in, then loads `/login?reason=replaced`. `SINGLE_SESSION_REQUIRED` (default `true`) is the kill switch: `false` and a restart. The e2e harness defaults it to `false`. Not covered: the chat's Realtime socket, which authorises in SQL, keeps delivering to a replaced device until its access token expires (up to an hour) or it makes an API call.

Roles are `CLIENT | FRONT_DESK | COACH | ADMIN | DEV`. `DEV` is the superuser escape hatch — assignable only by seed script or direct DB access, never through the API.

## Known rough edges

- `npm run typecheck --workspace=client` fails on `LayoutProps` in `src/app/layout.tsx` until Next has generated `.next/types` — run `npm run dev:client` or `build:client` at least once first.
- `nest build` is incremental and silently no-ops when `server/tsconfig.build.tsbuildinfo` is newer than a deleted `dist/`. If a build produces no output, delete that file and rebuild.
- `npm run test:e2e --workspace=server` needs its **own** database, built with `prisma migrate deploy` followed by `prisma db seed` — never `db push`. `db push` skips the hand-written SQL in `prisma/schema/migrations/*/migration.sql`, where every `CHECK` constraint in this design lives, so the whole integrity suite would pass against a schema that has none of them. Copy `server/.env.test.example` to `server/.env.test` and point it at a scratch project or a local Postgres; `test/support/db.ts` reads it. The raw Prisma CLI does its **own** dotenv load of `server/.env` and knows nothing about `TEST_DATABASE_URL`/`TEST_DIRECT_URL` — a manual `npx prisma migrate deploy` invocation must set `DATABASE_URL`/`DIRECT_URL` inline in that command's own environment, or it silently targets the real database.
- `API_PREFIX` exists in `.env` but is unused — `main.ts` hardcodes the `api` prefix and versioning.
- `client/.env.local` carries a `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` that no code reads; the client uses `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- `CHECK` constraints and partial indexes have **no Prisma representation** and live only in hand-written migration SQL, so a `migrate diff`, a `--create-only` regeneration or a local `db push` drops them silently while every service test keeps passing. `test/constraints.e2e-spec.ts`, `test/membership-constraints.e2e-spec.ts` and `test/checkin-constraints.e2e-spec.ts` are the only things that notice — keep them in CI. Assert the index *predicate*, not just its name: `StationScan_opening_checkin_once` shipped with `'REOPENED'` in its filter and made the check-out-undo path 500 at the counter, and a name-only assertion would not have caught it.
- Prisma warns that `package.json#prisma` is deprecated and goes away in Prisma 7 (currently on 6.19). Migrating means moving the schema-folder config into a `prisma.config.ts`.
- The throttler's storage is in-memory, so every limit is **per instance**. Running two instances doubles the effective limit; swap in a shared store before scaling horizontally.

## Conventions

Prettier config at the root is authoritative (single quotes, trailing commas, 100 cols, LF). Server TypeScript is `strict` with `noFallthroughCasesInSwitch`; env vars are read as `process.env['KEY']` (bracket access) to satisfy it.
