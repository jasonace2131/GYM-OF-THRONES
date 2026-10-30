# Deploying Gym of Thrones

Backend on **Railway**, frontend on **Vercel**, database and auth on **Supabase**.

> **Railway's trial has ended.** For a free stand-in while the permanent host
> is decided, see `docs/deploy-render.md` — `render.yaml` at the repo root is
> ready to deploy. Everything below about environment variables, secrets and
> the chicken-and-egg between CORS and the client URL still applies; only the
> host-specific mechanics differ.

This is a **staging deploy**, not a launch. The member portal is still mostly
mock data, so real members must not be given the URL yet. What this buys is the
one thing local development cannot:

> **`navigator.mediaDevices` is `undefined` on a non-secure origin.** `localhost`
> is exempt; `http://192.168.1.x:3000` on a real handset is not. **The member's
> camera scanner cannot be tested on a phone until it is on HTTPS.** Every iOS
> workaround in `CheckInScanner.tsx` — the awaited `play()`, the track
> revalidation after a background, the absence of a torch API — is a guess
> until a real iPhone hits a real HTTPS URL.

Two more things only a deploy can prove: whether Railway's proxy honours the
SSE feed's `X-Accel-Buffering: no` header, and whether `prisma migrate deploy`
plus the seed builds a working schema from nothing. Both have only ever run
against a database that already existed.

---

## 0. Before anything — rotate the service_role key

`SUPABASE_SERVICE_KEY` was committed in `3e9a0eb`. It is in this repository's
git history and is therefore public to anyone who has the repo.

A `service_role` key **bypasses row-level security entirely**. Today that is an
exposed credential on a development project; the moment it is the backend's
credential in Railway, it is an exposed credential on a live one.

Supabase dashboard → Project Settings → API → **Reset** the `service_role` key.
Rotating it invalidates the old value everywhere, which is the point. Update
`server/.env` locally with the new one at the same time.

Do this first. Everything below assumes it is done.

---

## 1. Generate the production secrets

```bash
node scripts/generate-deploy-secrets.mjs
```

**Generate fresh values rather than reusing `server/.env`.** To be precise
about why, because an earlier draft of this file got it wrong: no `.env` has
ever been committed — `.gitignore` denies everything `.env`-shaped and allows
back only the two templates, and a scan of every commit confirms it held. The
three local secrets are therefore not public.

They are still the wrong values to deploy. They live unencrypted on a
development machine, next to a `.env.backup-before-quoting`, on a laptop that
gets lent and backed up. A production `STATION_TOKEN_SECRET` should have a
blast radius of one system. The script prints three fresh values and explains
what rotating each one costs later.

What WAS exposed is separate and real: commit `3e9a0eb` shipped `.env.example`
containing two live JWTs. `SUPABASE_SERVICE_KEY` has since been rotated — the
current value differs from the committed one. `NEXT_PUBLIC_SUPABASE_ANON_KEY`
has not been, and does not need to be: the anon key is public by design, ships
in every browser bundle, and is protected by row-level security.

---

## 2. Railway — the API

Create a project from this repository. `railway.json` at the repo root already
carries the build, start, health-check and pre-deploy commands, so the only
thing to configure is environment.

### One service, and its root directory must be `/`

Railway sees three `package.json` files and offers to create a service per
workspace — `@got/server` **and** `@got/client`. **Take only the server.**
The client is a Next.js app that belongs on Vercel (§3); a second Railway
service would build the same repo twice, burn the trial credit at double rate,
and produce a Next server nothing points at.

Then check **Settings → Source → Root Directory**. Railway's monorepo detection
sets it to `/server`, and that combination cannot work here:

- `package-lock.json` and the `workspaces` field live at the **repo root**. With
  the build context at `/server`, npm installs `server/package.json` standalone
  and immediately fails on `"@got/shared": "*"` — there is no such package on
  the registry.
- `railway.json` is read from the service's root directory. At `/server` it is
  never found, so every command in it is silently ignored: no build command, no
  health check, and — worst of the three — **no `prisma migrate deploy`**, which
  ships an API pointed at a database with no tables.

Set Root Directory to `/` (clear the field). Build the whole workspace, start
one process out of it.

### Environment variables

**Secrets — from step 1 and from Supabase:**

| Variable                    | Where it comes from                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | Supabase → Connect → **Transaction pooler** (port 6543). **Must end with `?pgbouncer=true&connection_limit=5`** — see the trap below. |
| `DIRECT_URL`                | Supabase → Connect → **Session** (port 5432). Migrations cannot run through the pooler.                                               |
| `SUPABASE_URL`              | Supabase → Settings → API                                                                                                             |
| `SUPABASE_SERVICE_KEY`      | **Leave unset.** It is `.optional()` in the zod schema and nothing in the auth flow needs it — token verification uses the public JWKS. Rotating it (step 0) is still required; putting it in Railway is not. |
| `STATION_TOKEN_SECRET`      | Step 1                                                                                                                                |
| `STATION_CREDENTIAL_PEPPER` | Step 1                                                                                                                                |
| `IP_HASH_PEPPER`            | Step 1                                                                                                                                |

**Operational — these have defaults in the zod schema, but set them explicitly
so the deployed values are visible rather than implied:**

| Variable             | Value           | Why it matters                                                                                                                     |
| -------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`           | **do not set**  | It is in `startCommand` instead. As a service variable it is also present at BUILD time, where npm reads it as `--omit=dev` and skips `@nestjs/cli`, `typescript`, `prisma` and `ts-node` — the build then dies on `nest: not found`. |
| `CORS_ORIGIN`        | your Vercel URL | Comma-separated. See the chicken-and-egg note below.                                                                               |
| `GYM_TIMEZONE`       | `Asia/Manila`   | Every business date derives from it. Validated by construction, so a typo crashes the boot rather than silently formatting as UTC. |
| `GYM_OPEN_TIME`      | `05:00`         | Load-bearing: gates the station display and the member's own scan.                                                                 |
| `GYM_CLOSE_TIME`     | `22:00`         |                                                                                                                                    |
| `SCHEDULER_ENABLED`  | `true`          | **Set to `false` on every instance but one** if you ever scale past one — the nightly job is not distributed-safe.                 |
| `GYM_VAT_REGISTERED` | `false`         | Drives the statutory senior/PWD computation. Ask the owner before changing.                                                        |
| `LOGIN_CODE_REQUIRED` | `true`         | Every sign-in must enter an emailed 6-digit code. **Needs `RESEND_API_KEY` and `RESEND_FROM` set first** — with them missing nobody can finish signing in (the boot log says so). Merge the change that turns it on outside opening hours: every device already signed in asks for one code. If email breaks, set `false` and restart: everyone signs in with the password alone until it is fixed. The chat (Realtime) side of the switch follows only a production process (`NODE_ENV=production`): a local `npm run dev:server` never writes it. |
| `SINGLE_SESSION_REQUIRED` | `true`     | One device at a time: when an account signs in on a second device, the first is signed out on its next request and its login page says why. Needs migration `20261030000000_user_active_session` (applied by the normal `prisma migrate deploy`). If it ever gets in the way, set `false` and restart: accounts may then stay signed in on several devices. |

Everything else (`MEMBERSHIP_*`, `CHECKIN_*`, `STATION_*` thresholds,
`SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS`, `IDEMPOTENCY_RETENTION_HOURS`,
`GYM_EGRESS_CIDRS`) has a sensible default in
`server/src/config/env.validation.ts`. Leave them unset for a first deploy.

`PORT` is injected by Railway. Do not set it.

`STATION_TOKEN_SECRET_PREVIOUS` is unset normally, and set only for the single
deploy during which you are rotating the signing secret.

### Two traps

**`?pgbouncer=true` is not optional.** Without it, interactive transactions
intermittently fail with _"prepared statement s0 already exists"_ under
concurrency. It presents as random 500s on unrelated endpoints, not as a
configuration problem, and is close to undiagnosable from the symptom. The
check-in write path is an interactive transaction, so this bites at the busiest
moment.

**`DIRECT_URL` must be set or every prisma command fails with P1012** — including
the `preDeployCommand`, which means the deploy fails before it starts rather
than shipping a schema-less API.

### The pre-deploy command

```
cd server && npx prisma migrate deploy && npx prisma db seed
```

The seed is **not** optional and **not** idempotent-by-luck: it loads the
permission catalogue and role grants. Skipping it fails closed and silently —
every non-`DEV` role ends up with zero permissions, `/admin` 403s for an ADMIN,
and `/me` returns `permissions: []` with no crash to point at the cause.

It runs **between build and start**, so a failing migration aborts the deploy
and leaves the previous version serving. That is the behaviour you want: a
half-migrated schema never reaches the counter.

### When the build fails

| Log line | Cause | Fix |
| --- | --- | --- |
| `Module '"@prisma/client"' has no exported member 'Role'` (and ~194 more like it) | **`prisma generate` never ran.** `@prisma/client` ships as a 4KB stub; the real types only exist after generation reads your schema. Your machine has them from a `generate` you ran weeks ago — a fresh container does not. Its own postinstall looks for a schema in the current directory and yours is at `server/prisma/schema`, so from the repo root it finds nothing and silently no-ops. | Already fixed: `server/package.json` has `postinstall: prisma generate`, and the build command generates explicitly before `nest build`. |
| `nest: not found` / `tsc: not found` | devDependencies were skipped. Something set `NODE_ENV=production` at build time. | Remove `NODE_ENV` from the service variables. If it must stay, add `NPM_CONFIG_INCLUDE=dev`. |
| `npm error 404 @got/shared` | Root Directory is `/server`, so npm never saw the workspace. | Root Directory → `/`. |
| `Cannot find module '@got/shared'` at **runtime** | `shared/dist` was not built. The build command builds shared first — check it survived. | Confirm `buildCommand` in `railway.json` is being used at all (Root Directory `/`). |
| `P1012` on `preDeployCommand` | `DIRECT_URL` is missing. Prisma needs both URLs even to run a migration. | Add `DIRECT_URL` (port 5432). |
| `P1001 Can't reach database server` | Supabase project is paused, or the pooled host/port is wrong. | Wake the project; re-copy both strings. |
| Health check times out, no crash in logs | The app bound a port Railway isn't probing. `main.ts` reads `process.env.PORT`. | Do **not** set `PORT` — Railway injects it. |

---

## 3. Vercel — the client

Import the repository. Because this is an npm-workspaces monorepo and the
client imports `@got/shared` **from source**, the root `vercel.json` sets the
build to run from the repo root rather than from `client/`.

### Environment variables

All three are `NEXT_PUBLIC_`, which means **they are compiled into the browser
bundle at build time**. Two consequences: only ever put public values here, and
**changing one requires a rebuild, not a restart**.

| Variable                        | Value                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`           | `https://<your-app>.up.railway.app/api/v1` — **including the `/api/v1` suffix** |
| `NEXT_PUBLIC_SUPABASE_URL`      | Same as the server's `SUPABASE_URL`                                             |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The anon key. Public by design, protected by RLS.                               |

**Never put `SUPABASE_SERVICE_KEY` or a database password here.**

`client/src/lib/api.ts` falls back to `http://localhost:4000/api/v1` when
`NEXT_PUBLIC_API_URL` is unset. That is exactly the trap: a production build
with it missing does not fail — it silently ships a site that calls the
_visitor's own machine_.

---

## 4. The chicken and the egg

`CORS_ORIGIN` needs the Vercel URL and `NEXT_PUBLIC_API_URL` needs the Railway
URL, so one of them is wrong on the first pass. Order:

1. Deploy Railway with `CORS_ORIGIN` set to anything (`https://example.com`).
2. Deploy Vercel with `NEXT_PUBLIC_API_URL` pointing at the Railway URL.
3. Set Railway's `CORS_ORIGIN` to the real Vercel URL and redeploy.

`Idempotency-Key` must appear in the API's allowed headers or the browser
strips it at preflight — and that failure presents as **duplicate charges**,
not as a CORS error. It is already in `buildCorsOptions`; do not remove it.

---

## 5. After the first deploy

```
GET https://<railway-app>.up.railway.app/api/health
```

Then, in order:

1. **Seed the accounts** — `npm run seed:accounts --workspace=server` with the
   production `server/.env`, or create real staff accounts in Supabase and set
   their roles directly in the database. Roles are deliberately never settable
   through the API, so a compromised admin session cannot promote itself.
2. **Sign in to `/admin` as the ADMIN account.** If the nav is empty, the seed
   did not run.
3. **Provision a tablet** at `/admin/stations` → _Provision a tablet_. The key
   is shown **once**. Paste it into the tablet at `/desk/station`.
4. **Point a real phone at the tablet** and open `/portal/checkin`. This is the
   whole reason for deploying now, and the first time the scanner has ever run
   on a handset.

### What to watch for on that first scan

| Symptom                               | Almost certainly                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Camera unavailable"                  | Not HTTPS — check the Vercel URL, not an IP                                                                                                            |
| Camera opens, never decodes           | Module size. Check the tablet is portrait and the symbol fills the card                                                                                |
| Scans, then "Check-in is unavailable" | `CORS_ORIGIN` does not match the Vercel origin exactly                                                                                                 |
| Desk board never updates live         | Railway buffering the SSE stream despite `X-Accel-Buffering` — the 3-second poll on `/admin/attendance` still works, which is why that fallback exists |
| Everything 403s for an ADMIN          | The seed did not run                                                                                                                                   |

---

## Not ready for real members

- The member portal is **1 of 11 screens on live data** (only `/portal/subscription`).
  The rest render fabricated data.
- **No walk-in sale yet** — a non-member off the street cannot be sold anything,
  and a denied member cannot be resolved at the counter.
- **Announcements has no backend at all.**

Give the URL to staff and the owner. Not to members.
