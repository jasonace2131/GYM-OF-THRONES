# Authentication & RBAC — Design

**Date:** 2026-08-16
**Status:** Approved for planning
**Scope:** Identity, authorization, and user administration for the NestJS server.

---

## 0. Delivery phases

**This document describes the target, not the first deliverable.** Building all of it before anything works would be a mistake. It ships in additive phases, each of which leaves a working system:

| Phase | Contents | Working system at the end |
|---|---|---|
| **1** | Prerequisites (§3), `User` model, `PrismaModule`, `AuthGuard`, JIT provisioning, `@CurrentUser` / `@Public`, `GET /me`, client login/register wired to Supabase | Someone can register, log in, and call an authenticated endpoint that knows who they are |
| **2** | `Permission` + `RolePermission`, `PermissionsService`, `PermissionsGuard`, `@RequirePermission`, the version-keyed cache (§7), seeded catalogue | Endpoints are role-gated |
| **3** | `UserPermission` overrides, `PermissionScope` + `scopeFilter`, `CoachAssignment`, prerequisite enforcement | Coaches see only their members; individuals can be granted or denied specific permissions |
| **4** | Admin API (§11), `AuditLog`, source-tagged permissions | Admins can manage users and permissions, and privileged actions are recorded |
| **5** | QR check-in authentication (§8.2) | Members can check themselves in |

Later phases assume earlier ones but never require revising them. A phase may be dropped or reordered if it stops earning its place.

## 1. Scope

**In scope**

- Verifying identity on every API request and provisioning the local `User` record
- A role-based permission system with per-user overrides and row-level scoping
- Coach → member assignment, which powers row-level scoping
- Administrative APIs for managing users, roles, permissions and assignments
- An append-only audit log for privileged actions

**Out of scope** — these build on this module and get their own specs:

- Memberships, plans, payments
- Class scheduling and booking
- The AI fitness assistant (its permission keys are reserved here; see §9)
- The admin frontend

---

## 2. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Identity provider | Supabase Auth | Already scaffolded — `@supabase/supabase-js` is a dependency, `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` are required env vars, and `User.supabaseId` exists in `@got/shared`. Avoids owning password hashing, reset flows, and email verification. |
| Authorization model | Fixed role enum + DB permissions + per-user overrides | Roles stay type-safe across the shared package; permissions and overrides stay editable at runtime. |
| Enforcement | Permission keys carrying a scope (`OWN` \| `ALL`) | No new dependency, explicit and greppable. Endpoint access is guarded; row access is filtered in the service layer. |
| Coach visibility | Assigned members only, by default | Least privilege. Member contact details and payment history are sensitive. |
| Locations | Single location | No `Branch` concept. Adding one later is a nullable `branchId` plus scoping in the resolver. |
| `DEV` role | Audited superuser, DB-assignable only | An escape hatch for debugging that cannot be escalated into through the API. |

**Deferred but anticipated.** The gym intends to eventually own password reset, email verification and OAuth rather than delegating them to Supabase. The design therefore puts all identity operations behind a port (§4) so that migration is an adapter swap, not a rewrite of every service.

---

## 3. Prerequisites

Two existing defects block this work and are fixed as part of it.

### 3.1 `@got/shared` has no build step

`shared/package.json` sets `main` to `./src/index.ts`, so Node cannot `require` the package. Server code must currently use `import type` only; importing a runtime value compiles but throws at runtime.

RBAC needs runtime values on both sides — the permission catalogue for seeding and guards on the server, and for UI gating on the client. **Resolution:** give `shared` a real build step (`tsc` → `dist/`, `main` → `dist/index.js`, wired into the root `build` script), and delete the stale hand-run `.js`/`.d.ts` files currently sitting beside the sources in `shared/src/`.

### 3.2 `DIRECT_URL` is missing

`prisma/schema/schema.prisma` references `env("DIRECT_URL")` but it is absent from `.env.example` and `.env`, so every `prisma migrate` fails with P1012. This module introduces the first migrations, so it must be fixed here: add `DIRECT_URL` to `.env.example`, to `server/src/config/env.validation.ts`, and to local `.env` files. It is the Supabase **direct** (non-pooled) connection string; `DATABASE_URL` remains the pooled one.

### 3.3 Committed credentials (security)

`.env.example` is tracked and contains a real Supabase project ref and a real `service_role` key, and is present in the pushed commit `3e9a0eb`. The `service_role` key bypasses Row Level Security entirely.

**Required, in order:** rotate the `service_role` key in the Supabase dashboard (this is the step that actually remediates), then replace the values in `.env.example` with placeholders. Rewriting git history is optional cleanup once the key is rotated, since the leaked key is then worthless.

---

## 4. Module architecture

```
server/src/
  prisma/       PrismaModule (global) — PrismaService with lifecycle hooks
  identity/     identity.port.ts       — IdentityProvider interface
                supabase.adapter.ts    — the only file that imports supabase-js
  auth/         jwt-verifier.service.ts — local JWKS verification, cached
                auth.guard.ts           — global APP_GUARD
                user-provisioning.service.ts
                decorators/             — @Public, @CurrentUser
  rbac/         permission-registry.ts  — canonical catalogue (typed)
                permissions.service.ts  — resolution + cache
                permissions.guard.ts    — global APP_GUARD, runs after auth
                scope.util.ts           — scopeFilter() helpers
                decorators/             — @RequirePermission
  users/        users.controller.ts        — self-service (/me)
                admin-users.controller.ts  — administration
                users.service.ts
                coach-assignments.service.ts
  audit/        audit.service.ts, audit.interceptor.ts
```

**The identity port** is the boundary that makes §2's deferred migration cheap:

```ts
export interface IdentityProvider {
  verifyToken(token: string): Promise<IdentityClaims>;
  getUser(externalId: string): Promise<IdentityUser | null>;
  updateEmail(externalId: string, email: string): Promise<void>;
  deleteUser(externalId: string): Promise<void>;
}
```

No service outside `identity/` imports `supabase-js`.

---

## 5. Database schema

Prisma is configured folder-based (`prisma.schema = "prisma/schema"`), so each model gets its own `.prisma` file.

### 5.1 Enums (`prisma/schema/enums.prisma`)

```prisma
enum Role             { MEMBER FRONT_DESK COACH ADMIN DEV }
enum UserStatus       { ACTIVE SUSPENDED DEACTIVATED }
enum PermissionScope  { OWN ALL }
enum PermissionEffect { GRANT DENY }
```

`FRONT_DESK` exists because the counter tablet is a **shared device in a public space** — a different trust context from a staff laptop. It can check members in, look someone up by name, and record a walk-in; it cannot open a member profile, see payment history, or reach anything administrative. Every comparable platform surveyed (§14) has this role for the same reason.

### 5.2 `User` (`prisma/schema/user.prisma`)

```prisma
model User {
  id                String     @id @default(uuid()) @db.Uuid
  supabaseId        String     @unique @db.Uuid
  email             String     @unique
  firstName         String
  lastName          String
  phone             String?
  avatarUrl         String?
  role              Role       @default(MEMBER)
  status            UserStatus @default(ACTIVE)
  permissionVersion Int        @default(0)
  lastSeenAt        DateTime?
  createdAt         DateTime   @default(now())
  updatedAt         DateTime   @updatedAt
  deletedAt         DateTime?

  permissionOverrides UserPermission[]  @relation("PermissionTarget")
  grantedOverrides    UserPermission[]  @relation("PermissionGrantor")
  coachOf             CoachAssignment[] @relation("Coach")
  assignedCoach       CoachAssignment[] @relation("Member")
  auditEntries        AuditLog[]        @relation("AuditActor")

  @@index([role, status])
}
```

`permissionVersion` exists solely for cache invalidation — see §7.

**Breaking change to `@got/shared`:** `membershipStatus` is removed from the `User` type. Membership is a record with a plan, a start and an end — it belongs to a future `Membership` model, not a column here. `UserRole.TRAINER` is renamed to `COACH` and `DEV` is added, while nothing depends on the old names.

### 5.3 `Permission` (`prisma/schema/permission.prisma`)

Seeded from `permission-registry.ts`, never user-created.

```prisma
model Permission {
  id          String   @id @default(uuid()) @db.Uuid
  key         String   @unique          // 'member.read'
  resource    String                    // 'member'
  action      String                    // 'read'
  description String
  isDangerous Boolean  @default(false)  // requires explicit confirm flag
  requires    String[] @default([])     // prerequisite permission keys

  rolePermissions RolePermission[]
  userPermissions UserPermission[]

  @@index([resource])
}

model RolePermission {
  id           String          @id @default(uuid()) @db.Uuid
  role         Role
  permissionId String          @db.Uuid
  scope        PermissionScope @default(OWN)
  permission   Permission      @relation(fields: [permissionId], references: [id], onDelete: Cascade)

  @@unique([role, permissionId])
  @@index([role])
}

model UserPermission {
  id           String           @id @default(uuid()) @db.Uuid
  userId       String           @db.Uuid
  permissionId String           @db.Uuid
  effect       PermissionEffect
  scope        PermissionScope  @default(OWN)
  reason       String?
  expiresAt    DateTime?
  grantedById  String?          @db.Uuid
  createdAt    DateTime         @default(now())

  user       User       @relation("PermissionTarget",  fields: [userId],      references: [id], onDelete: Cascade)
  grantedBy  User?      @relation("PermissionGrantor", fields: [grantedById], references: [id], onDelete: SetNull)
  permission Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)

  @@unique([userId, permissionId])
  @@index([userId])
  @@index([expiresAt])
}
```

`reason` and `expiresAt` are what make overrides operable rather than mysterious: the admin UI can show *why* a coach has billing access and when it lapses.

### 5.4 `CoachAssignment` (`prisma/schema/coach-assignment.prisma`)

```prisma
model CoachAssignment {
  id           String    @id @default(uuid()) @db.Uuid
  coachId      String    @db.Uuid
  memberId     String    @db.Uuid
  assignedById String?   @db.Uuid
  startedAt    DateTime  @default(now())
  endedAt      DateTime?

  coach  User @relation("Coach",  fields: [coachId],  references: [id], onDelete: Cascade)
  member User @relation("Member", fields: [memberId], references: [id], onDelete: Cascade)

  @@unique([coachId, memberId])
  @@index([memberId])
  @@index([coachId, endedAt])
}
```

`endedAt` is a soft end so history survives reassignment. Active assignments are `endedAt IS NULL`.

### 5.5 `AuditLog` (`prisma/schema/audit-log.prisma`)

```prisma
model AuditLog {
  id         BigInt   @id @default(autoincrement())
  actorId    String?  @db.Uuid
  actorRole  Role?
  action     String              // 'user.permission.grant'
  targetType String?
  targetId   String?
  metadata   Json?
  ip         String?
  userAgent  String?
  createdAt  DateTime @default(now())

  actor User? @relation("AuditActor", fields: [actorId], references: [id], onDelete: SetNull)

  @@index([actorId, createdAt])
  @@index([targetType, targetId])
  @@index([createdAt])
}
```

Append-only. `actorRole` is denormalised deliberately — it records the role *at the time of the action*, which a join to `User` would lose after a role change.

---

## 6. Permission resolution

```
if user.role == DEV:
    return ALL permissions at scope ALL     # and audit the action

base   = RolePermission where role = user.role
grants = UserPermission where effect = GRANT and (expiresAt is null or expiresAt > now)
denies = UserPermission where effect = DENY  and (expiresAt is null or expiresAt > now)

effective = (base ∪ grants) − denies
scope(k)  = max(scope) where ALL > OWN
```

**DENY always beats GRANT**, and a DENY removes a role-inherited permission. This is what makes "stop this one coach editing classes" a single row rather than a role change.

### Scope enforcement

The guard answers *may this user do this at all*. The service answers *to which rows*:

```ts
@RequirePermission('member.read')
async findMembers(@CurrentUser() user: AuthUser) {
  return this.prisma.user.findMany({
    where: { role: 'MEMBER', ...scopeFilter(user, 'member.read') },
  });
}

// scopeFilter →
//   ALL : {}
//   OWN : { assignedCoach: { some: { coachId: user.id, endedAt: null } } }
```

Promoting one coach to see every member is then an insert into `UserPermission` with `scope = ALL` — no code change and no role change.

---

## 7. Caching

Cache key: `perm:{userId}:{permissionVersion}`. Any change to a user's role or overrides increments `User.permissionVersion` in the same transaction.

This is the property that makes the design scale horizontally: **a changed version yields a different cache key, so every server instance invalidates itself.** There is no pub/sub, no cross-instance invalidation protocol, and no stale-permission window. Start with an in-memory LRU (60s TTL); moving to Redis later reuses the identical key scheme behind a `CacheStore` port.

The `User` row itself is loaded fresh per request — one indexed lookup on `supabaseId` — so suspending an account takes effect on the next request rather than after a TTL.

JWTs are verified **locally against a cached JWKS**. `supabase.auth.getUser()` is never called in the request path; that would add a network round-trip to every single API call.

---

## 8. Request lifecycle

1. `ThrottlerGuard` — existing global rate limit
2. `AuthGuard` — skip if `@Public()`; else extract the bearer token and verify it locally
3. Load `User` by `supabaseId`; provision just-in-time if absent (§8.1)
4. Reject with `403` unless `status === ACTIVE`
5. `PermissionsGuard` — read `@RequirePermission` metadata, resolve effective permissions from cache, allow or `403`
6. Controller → service applies `scopeFilter` for row-level access
7. `AuditInterceptor` records mutations

### 8.1 Just-in-time provisioning

A user can exist in Supabase Auth before the API has ever seen them. On the first authenticated request with an unknown `supabaseId`, upsert a `User` with `role = MEMBER`, sourcing name and email from the verified token claims. This is self-healing and needs no webhook; a Supabase webhook can be added later as an optimisation, not a correctness fix.

### 8.2 QR check-in authentication

Attendance is scanned **member-side**: a rotating QR is displayed at the counter and the member scans it with the member app. Because the member is already authenticated, **the QR carries no identity** — identity comes from the member's own JWT. The QR only has to prove *physical presence*, which means exactly one device rotates a secret rather than every member's phone carrying a bearer credential.

```
Counter tablet (logged in as a FRONT_DESK user)
  └─ GET /checkin/station-token   every ~30s
     └─ { token, expiresAt }  → rendered as a QR

Member app (authenticated member)
  └─ POST /checkin  { stationToken }
     Authorization: Bearer <member JWT>
       ├─ member JWT valid, User.status == ACTIVE
       ├─ stationToken signature valid and unexpired
       ├─ (userId, stationToken) not already consumed   ← replay guard
       └─ → Attendance record
```

**Station token.** An HMAC over `(stationId, timeWindow)` using a server-side secret, with a 30-second TTL and a small overlap window to absorb clock skew and scan latency. It is never persisted — it is recomputed and verified, so there is no token table to grow.

**Replay guard.** A `CheckInNonce` row keyed `@@unique([userId, tokenHash])` with a short retention (delete rows older than a few minutes). This stops the same scan being submitted twice; the 30-second TTL bounds how long a photographed code is worth anything.

**Residual risk, stated plainly.** A member can screenshot the QR and send it to someone else within the 30-second window. This is inherent to any presence proof that does not use hardware. It is mitigated, not eliminated, by the short TTL plus a per-member check-in rate limit (one per N hours). If it ever needs to be eliminated, the options are a geofence on the member app or physical turnstile integration — both out of scope here.

**No-phone fallback.** A `FRONT_DESK` user checks the member in manually with `checkin.create`. This bypasses the presence proof by design, so it is always audited with the acting staff member recorded.

**Dependency.** Credit deduction (class packs, PT sessions) is deliberately *not* part of this module — it requires the `Membership` model, which is a later spec. This module authenticates and records the check-in; the attendance module consumes it. The token design does not change when deduction is added.

---

## 9. Permission catalogue

Seeded from `permission-registry.ts`. Initial set:

| Resource | Keys | Prerequisites |
|---|---|---|
| `member` | `member.read` | — |
| | `member.create`, `member.update`, `member.suspend`, `member.delete` | `member.read` |
| `checkin` | `checkin.self` — a member checks *themselves* in by scanning | — |
| | `checkin.read` | — |
| | `checkin.create` — staff check a member in manually | `checkin.read` |
| | `checkin.station_token.issue` — render the counter QR | — |
| `coach` | `coach.read` | — |
| | `coach.assign`, `coach.update` | `coach.read` |
| `permission` | `permission.read` | — |
| | `permission.grant`, `permission.revoke` | `permission.read` |
| `role` | `role.read` | — |
| | `role.change`, `role.permissions.update` | `role.read`, `permission.read` |
| `announcement` | `announcement.read` | — |
| | `announcement.create`, `announcement.update`, `announcement.delete` | `announcement.read` |
| `audit` | `audit.read` | — |
| `ai` | `ai.chat.use`, `ai.chat.history.read`, `ai.admin.configure` | — |

**Prerequisites** are declared in the registry and **enforced on write**: granting a permission whose prerequisites the target user would not hold is rejected with a `422` naming the missing keys. Nothing is auto-granted — a user never ends up holding a permission no one explicitly gave them, which keeps the audit trail honest and avoids the "what does this user actually have?" problem §14 documents. Resolution (§6) stays a pure set operation and never consults `requires`.

The `checkin.*` keys are the `FRONT_DESK` role's entire surface, alongside `member.read` scoped to name-and-photo only at the DTO layer.

`Permission.resource` and `Permission.action` are derived from the key by splitting on the first and last dot respectively, so every key must be `resource.action` or `resource.sub.action`.

The `ai.*` keys are **reserved here and seeded, but unused until the AI assistant module ships**. They are declared now so the assistant attaches to an existing permission surface — `ai.chat.history.read` at scope `OWN` lets a member read their own conversations, and at scope `ALL` lets an admin read anyone's, using the same machinery as everything else. They are deliberately provider-neutral: nothing in this module assumes which model vendor the assistant is built on.

`role.change`, `permission.grant`, `member.delete` are marked `isDangerous`.

---

## 10. Guardrails

Enforced in `PermissionsService`, not left to the UI:

- **No privilege escalation** — you cannot grant a permission you do not hold yourself
- **No self-promotion** — you cannot change your own role
- **No self-lockout** — you cannot DENY yourself `permission.grant` or `role.change`
- **Last admin standing** — the final `ADMIN` cannot be demoted or suspended
- **DEV is out of band** — assignable only by seed or direct DB access, never through the API
- **Dangerous permissions** require an explicit `confirm: true` on the request body
- **Prerequisites hold** — a grant is rejected (`422`) if the target would not hold every key in `requires`; a revoke is rejected if another held permission still depends on it

---

## 11. API surface

```
GET    /me                                    profile + effective permissions
PATCH  /me                                    own profile fields only

GET    /admin/users                           cursor-paginated; filter role/status/query
GET    /admin/users/:id
PATCH  /admin/users/:id                       profile + status
PATCH  /admin/users/:id/role                  audited; guardrails apply
GET    /admin/users/:id/permissions           effective, each tagged with source
PUT    /admin/users/:id/permissions           set overrides (bulk)
DELETE /admin/users/:id/permissions/:key      remove one override

GET    /admin/permissions                     catalogue, grouped by resource
GET    /admin/roles/:role/permissions
PUT    /admin/roles/:role/permissions

POST   /admin/coach-assignments
DELETE /admin/coach-assignments/:id
GET    /admin/coaches/:id/members

GET    /admin/audit                           cursor-paginated; filter actor/target/date
```

**Source tagging** on `GET /admin/users/:id/permissions` is what makes a usable admin UI possible. Each entry returns as one of:

```jsonc
{ "key": "member.read", "scope": "OWN", "source": "role",   "role": "COACH" }
{ "key": "billing.read", "scope": "ALL", "source": "grant",  "grantedBy": "…", "reason": "…", "expiresAt": "…" }
{ "key": "class.update", "source": "denied", "reason": "…" }
```

Without this the screen can only render a checkbox; with it, it can explain itself.

All responses flow through the existing `TransformInterceptor` / `HttpExceptionFilter`, so the envelope is unchanged.

---

## 12. Testing

**Unit — the resolution matrix.** `PermissionsService` is pure logic with no I/O, so it is cheap to cover exhaustively: role × grant × deny × scope × expiry, plus every guardrail in §10. This is the piece worth being thorough about; a bug here is a security bug.

**Unit — `scopeFilter`.** Asserts the exact Prisma `where` shape per scope. Cheap, and it catches the case where an `OWN` filter silently resolves to `{}`.

**E2E.** One fixture user per role with a signed test JWT, exercising real endpoints: a coach can read an assigned member and gets `403` on an unassigned one; a granted override flips that to success; a DENY overrides a role grant; a suspended user is rejected at the guard.

**Seed fixtures.** One `ADMIN`, one `COACH` with two assigned members, three `MEMBER`s, one `DEV`.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Leaked `service_role` key (§3.3) | Rotate before deploying anything built on this |
| A service method forgets `scopeFilter`, leaking rows | Explicit e2e coverage per scoped endpoint; the `OWN`/`ALL` distinction is meaningless without it. This is the known cost of the chosen enforcement model. |
| Supabase outage blocks all auth | JWT verification is local against a cached JWKS, so existing tokens keep working through a brief outage; only issuing new ones fails |
| `permissionVersion` not incremented on a write path | Confine every permission mutation to `PermissionsService`; no controller writes `UserPermission` directly |
