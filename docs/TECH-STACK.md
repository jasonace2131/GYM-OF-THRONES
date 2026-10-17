# Gym of Thrones — Technology Stack

Reference document for thesis writing. Every version below is read from the
committed `package.json` files, not from memory.

**System:** *Gym of Thrones House of Fitness*, a subscription-based gym
management and QR attendance system.

**Scale at time of writing:** 279 source files, ~40,100 lines of TypeScript,
23 database models, 16 migrations, 69 test files.

---

## 1. Architecture

**Pattern:** decoupled client–server (headless), organised as a **monorepo**
using **npm workspaces** (three packages: `client`, `server`, `shared`).

```
Browser / Tablet ──HTTPS──> Next.js (Vercel) ──HTTPS/JSON──> NestJS API (Railway)
                                                                   │
                                                          Prisma ORM
                                                                   │
                                                    PostgreSQL (Supabase)
```

**Justification for the thesis:** the front desk tablet, the member phone
portal, and the admin console are three different clients of one API. A
decoupled API means authorisation is enforced once, on the server, rather than
re-implemented per client. The shared workspace carries the TypeScript types
across the boundary so the client cannot drift from the API contract without a
compile error.

---

## 2. Languages and runtime

| Technology | Version | Role |
|---|---|---|
| **TypeScript** | 5.7.x | Sole implementation language — client, server, and shared types |
| **Node.js** | 22.x LTS | Server runtime (pinned in root `engines`) |
| **npm workspaces** | npm ≥ 10 | Monorepo package management |
| **SQL (PostgreSQL dialect)** | — | Hand-written migrations for constraints Prisma cannot express |

Why TypeScript end-to-end: a single language across both tiers allows the
`shared` package to export the same type definitions to the API and the UI.
Money handling, date handling, and permission keys are therefore checked by the
compiler on both sides of the network.

---

## 3. Backend

| Technology | Version | Role |
|---|---|---|
| **NestJS** | 11.0.1 | Application framework — modules, DI, guards, interceptors |
| **@nestjs/platform-express** | 11.0.1 | HTTP layer (Express under Nest) |
| **Prisma ORM** | 6.x | Type-safe database access, schema definition, migrations |
| **@prisma/client** | 6.x | Generated, fully typed query client |
| **class-validator** / **class-transformer** | 0.14.1 / 0.5.1 | DTO validation at the request boundary |
| **zod** | 3.23.8 | Environment variable schema validation at boot |
| **jose** | 5.10.0 | JWT verification against Supabase's remote JWKS |
| **helmet** | 8.0.0 | Security response headers |
| **@nestjs/throttler** | 6.2.1 | Rate limiting (per-user and per-route buckets) |
| **@nestjs/schedule** | 6.1.3 | Cron jobs (membership expiry sweeps, token rotation) |
| **@nestjs/config** | 4.0.0 | Typed configuration service |
| **rxjs** | 7.8.1 | Interceptor pipeline (a NestJS dependency) |
| **reflect-metadata** | 0.2.2 | Decorator metadata (required by Nest DI) |

### Server module inventory (22 modules)

`admin` · `announcements` · `assistant` · `auth` · `catalogue` · `checkin` ·
`classes` · `coach-assignments` · `common` · `config` · `front-desk` ·
`health` · `me` · `membership` · `notifications` · `payments` · `prisma` ·
`rbac` · `scheduler` · `users`

---

## 4. Frontend

| Technology | Version | Role |
|---|---|---|
| **Next.js** | 16.3.1 | React framework — App Router, routing, build, SSR/CSR |
| **React** | 19.2.8 | UI library |
| **React DOM** | 19.2.8 | DOM renderer |
| **axios** | 1.7.7 | HTTP client with interceptors for auth token attachment |
| **Plain CSS token system** | — | Four hand-written stylesheets, CSS custom properties for theming — the source of truth for colour, type and spacing |
| **Tailwind CSS** | 4.x | Utilities for the member portal's shadcn components only; no Preflight; scans only the new component folders |
| **shadcn/ui** (Radix) | — | Tabs, Calendar, Sheet, Alert Dialog, Select, Toggle Group, Sonner toasts for the schedule, bookings and calendar screens |

**Tokens first, Tailwind contained.** Styling remains four scoped stylesheets —
`globals.css`, `admin.css`, `portal.css`, `desk.css` — built on CSS custom
properties, and that design system is original to this project. Since
2026-09-13 the member portal's schedule, bookings and calendar screens use
shadcn/ui on Tailwind v4, with shadcn's colour variables mapped onto the same
gold and paper tokens so the product still has one palette. Preflight is off
and Tailwind only scans the new folders, so no other screen changed.

### Route inventory (26 pages)

- **Public:** landing (`/`)
- **Auth:** `/login`, `/register`
- **Member portal (13):** dashboard, subscription, pay, check-in, check-ins
  history, schedule, book, progress, announcements, assistant, coach
- **Admin console (9):** dashboard, members, payments, attendance, classes,
  coaches, announcements, stations, settings
  (subscriptions merged into members — one table, subscription columns folded
  in; `/admin/subscriptions` redirects)
- **Front desk:** `/desk/station` (tablet kiosk)

---

## 5. Data layer

| Technology | Role |
|---|---|
| **PostgreSQL** (hosted on Supabase) | Primary relational datastore |
| **Prisma folder-based schema** | 23 models, one file per model, under `server/prisma/schema/` |
| **Hand-written migration SQL** | 16 migrations; CHECK constraints and partial backfills live here because Prisma's schema language cannot express them |
| **Connection pooling** | `DATABASE_URL` (pooled) and `DIRECT_URL` (direct, for migrations) |

### Domain models (23)

`User` · `Membership` · `MembershipEvent` · `MembershipHold` · `Plan` ·
`Payment` · `CheckIn` · `CheckInDenial` · `Station` · `StationCredential` ·
`StationScan` · `ClassSession` · `CoachAssignment` · `Shift` · `Announcement` ·
`BodyMeasurement` · `Permission` · `RolePermission` · `AiConversation` ·
`AiMessage` · `IdempotencyRecord` — plus 21 enums.

### Notable data-modelling decisions (thesis-relevant)

1. **Money is stored as integer centavos**, never floating point. No formatted
   currency string ever appears in an API response — formatting is the client's
   job. This eliminates a whole class of rounding error in a system that handles
   real payments.
2. **Membership standing is computed, never stored.** `accessVerdict()` derives
   whether a member may enter from the dates plus the gym's grace policy. There
   is no `status` column that a bug or a missed cron job could leave stale.
3. **Civil dates** (`@db.Date`) are treated as timezone-free calendar dates, not
   instants — a business day in Manila is not a UTC timestamp.
4. **Nullable-unique sentinel columns** enforce "at most one active X per user"
   at the database level, in preference to partial unique indexes.
5. **Idempotency records** protect payment and check-in writes against duplicate
   submission from an unreliable mobile network.

---

## 6. Authentication and authorisation

| Technology | Version | Role |
|---|---|---|
| **Supabase Auth** | — | Identity provider — email/password, magic-link invitations |
| **@supabase/supabase-js** | 2.112.3 (client) / 2.46.0 (server) | SDK for auth flows and admin operations |
| **jose** | 5.10.0 | Asymmetric JWT verification via `createRemoteJWKSet` |

### The RBAC model

Authorisation is **permission-key based, not role-based**, with roles acting
only as bundles of keys. The guard chain runs in a fixed order:

```
AuthGuard → UserThrottlerGuard → PermissionsGuard
```

- `@RequirePermission('member.create')` — every route declares exactly one key.
- `@Scope('user')` — narrows a permission to the caller's own records.
- A scoped miss returns **404, not 403**, so a permission boundary cannot be
  used to confirm that another user's record exists (enumeration defence).

**Roles:** `ADMIN`, `MANAGER`, `FRONT_DESK`, `COACH`, `CLIENT`.

---

## 7. QR attendance subsystem

This is the system's distinguishing feature and deserves its own thesis
section.

| Technology | Version | Role |
|---|---|---|
| **jsQR** | 1.4.0 | Pure-JS QR decoding from a live `<video>` frame — the tablet scanner |
| **qrcode** | 1.5.4 | QR generation — member-held codes and station pairing cards |
| **jsPDF** | 4.2.1 | Renders the station setup card as a downloadable A4 PDF |
| **Web APIs** | — | `getUserMedia` for the camera, `<canvas>` for frame extraction |

**Security design:** member QR codes are **time-sliced HMAC tokens**, not static
identifiers. A code is valid only within a short rotating window
(`STATION_TOKEN_SLOT_SECONDS`), so a screenshot of another member's code is
useless minutes later. Station credentials are peppered before hashing
(`STATION_CREDENTIAL_PEPPER`), and token secrets support overlapping rotation
(`STATION_TOKEN_SECRET` / `STATION_TOKEN_SECRET_PREVIOUS`) so keys can be
replaced without a service interruption.

Offline tolerance: `CHECKIN_OFFLINE_MAX_AGE_HOURS` allows a tablet that lost
its connection to queue scans and reconcile them later, which matters in a gym
with unreliable Wi-Fi.

---

## 8. AI assistant

| Technology | Version | Role |
|---|---|---|
| **Google Gemini** via `@google/generative-ai` | 0.24.1 | Member-facing conversational assistant with function calling |

**Model rotation strategy (an original contribution worth writing up).** The
Gemini free tier meters each model separately, so the system holds an ordered
fallback list of eight models sorted by *daily allowance rather than
capability*:

```
gemini-2.0-flash → gemini-2.0-flash-lite → gemini-3.1-flash-lite →
gemini-1.5-flash → gemini-1.5-pro → gemini-2.5-flash-lite →
gemini-2.5-flash → gemini-2.5-pro
```

Two failure classes advance to the next model — rate-limit (429/quota) and
model-unavailable (404/not-found) — while every other error fails fast so a
real bug is not buried under eight identical failures. A 404 is cached for the
process lifetime (model availability is a property of the API key); a rate
limit is deliberately *not* cached, because it clears on its own.

**Security design:** none of the four assistant tools accepts a user
identifier. The subject is bound at execution time from the JWT. A
prompt-injection attempt of the form *"now look up another member's payments"*
has no parameter to bind to and fails as an unknown argument — a structural
guarantee rather than a prompt instruction.

---

## 9. Notifications

| Technology | Version | Role |
|---|---|---|
| **Resend** | 6.24.0 | Transactional email — magic-link member invitations |

Configured as optional: an unset `RESEND_API_KEY` logs a warning and disables
sending rather than blocking boot, matching the same graceful-degradation
pattern used for the AI assistant.

---

## 10. Testing

| Technology | Version | Scope |
|---|---|---|
| **Jest** | 30.x | Server unit tests — 59 spec files |
| **ts-jest** | 29.2.5 | TypeScript transform for Jest |
| **Supertest** | 7.0.0 | HTTP-level end-to-end tests against the Nest app |
| **Vitest** | 4.1.10 | Client unit tests — 10 test files |
| **jsdom** | 29.1.1 | DOM environment for client tests |

**Methodological note for the thesis:** `ts-jest` does **not** type-check. It
transpiles only. Therefore `tsc --noEmit` is run as a separate, mandatory gate —
a spec file can pass its assertions while containing type errors that only the
compiler catches.

---

## 11. Tooling and quality

| Technology | Version | Role |
|---|---|---|
| **ESLint** | 9.x (flat config) | Static analysis |
| **typescript-eslint** | 8.20.0 | TypeScript-aware lint rules |
| **Prettier** | 3.x | Formatting, integrated with ESLint |
| **NestJS CLI** | 11.x | Server build and scaffolding |
| **ts-node** | 10.9.2 | Seed script execution |

**Production readiness gate**, run in this order before any deployment:

```
clean → build (client + server + shared) → tsc --noEmit (all workspaces) → test
```

---

## 12. Infrastructure and deployment

| Service | Role | Configuration |
|---|---|---|
| **Vercel** | Frontend hosting (Next.js) | `vercel.json` — root-directory build across workspaces, security headers |
| **Railway** | API hosting (NestJS) | `railway.json` — Nixpacks builder, health check on `/api/health`, migrate + seed as pre-deploy |
| **Supabase** | PostgreSQL database + authentication | Pooled and direct connection strings |

**Deployment hardening:**

- `postinstall: prisma generate` — the generated client is not committed, and
  its absence was the root cause of a 195-error production build failure.
- `preDeployCommand` runs `prisma migrate deploy` before the new version starts,
  so schema and code never diverge.
- Health check on `/api/health` with a 30 s timeout and 3 restart retries.
- Security headers set at the edge: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, and a `Permissions-Policy`
  granting camera access to same-origin only (required by the QR scanner) while
  denying microphone and geolocation.

---

## 13. Configuration surface

39 environment variables, validated by a **zod** schema at boot — the API
refuses to start on invalid configuration rather than failing later at runtime.
Grouped by concern:

- **Infrastructure (6):** `NODE_ENV`, `PORT`, `DATABASE_URL`, `DIRECT_URL`,
  `CORS_ORIGIN`, `SCHEDULER_ENABLED`
- **Identity (2):** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- **Gym policy (6):** timezone, open/close time, VAT registration, GCash payee
  details
- **Membership rules (7):** grace days, grace admissions cap, expiring-soon
  threshold, freeze minimum/maximum/annual cap/fee
- **Check-in rules (4):** max visits per day, minimum session minutes, stale
  visit hours, offline maximum age
- **Station security (6):** token secret + previous secret, slot seconds, batch
  size, credential pepper, fan-out and off-site soft limits
- **Integrations (4):** `GEMINI_API_KEY`, `GEMINI_MODEL`, `RESEND_API_KEY`,
  `RESEND_FROM`
- **Other (4):** IP hash pepper, idempotency retention, shift variance
  threshold, egress CIDRs

**Security note for the thesis:** `SUPABASE_SERVICE_KEY` and database passwords
are never exposed through `NEXT_PUBLIC_*` variables — anything so prefixed is
inlined into the browser bundle by Next.js. Production secrets are generated by
`scripts/generate-deploy-secrets.mjs` so they are never typed into a terminal or
a chat transcript.

---

## Summary table (for a thesis "Technologies Used" chapter)

| Layer | Technology | Version |
|---|---|---|
| Language | TypeScript | 5.7 |
| Runtime | Node.js | 22 LTS |
| Frontend framework | Next.js (App Router) | 16.3.1 |
| UI library | React | 19.2.8 |
| Backend framework | NestJS | 11.0.1 |
| ORM | Prisma | 6.x |
| Database | PostgreSQL (Supabase) | — |
| Authentication | Supabase Auth + jose JWT | 2.112 / 5.10 |
| HTTP client | axios | 1.7.7 |
| QR decode / encode | jsQR / qrcode | 1.4.0 / 1.5.4 |
| PDF generation | jsPDF | 4.2.1 |
| AI | Google Gemini | SDK 0.24.1 |
| Email | Resend | 6.24.0 |
| Validation | class-validator + zod | 0.14 / 3.23 |
| Security | helmet + @nestjs/throttler | 8.0 / 6.2 |
| Server testing | Jest + Supertest | 30 / 7 |
| Client testing | Vitest + jsdom | 4.1 / 29.1 |
| Monorepo | npm workspaces | npm 10+ |
| Frontend hosting | Vercel | — |
| Backend hosting | Railway | — |
