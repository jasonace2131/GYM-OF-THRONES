# Authentication Phase 2 — RBAC/Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Endpoints become role-gated. A `Permission` catalogue and `RolePermission` grants live in the database, a cached `PermissionsService` resolves what a user may do, `@RequirePermission()` + a global `PermissionsGuard` enforce it, `GET /me` reports the caller's effective permissions, and a first real protected endpoint (`GET /admin/permissions`) proves the whole path end to end.

**Architecture:** `PermissionsGuard` runs as a second global `APP_GUARD`, after the existing `AuthGuard`. It reads `@RequirePermission(key)` metadata off the route; if present, it asks `PermissionsService.hasPermission(user, key)`, which resolves the user's role grants from `RolePermission` (or, for `DEV`, every catalogue key at scope `ALL`) and caches the result in memory keyed by `{userId}:{permissionVersion}` — a role or permission change bumps the version, so every cache entry for that user is naturally stale on the next lookup. Scope enforcement (`OWN` vs `ALL` row filtering) and per-user overrides are **not** built here — they're Phase 3. This phase only answers "may this user call this endpoint at all."

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL/Supabase), Jest + ts-jest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-16-rbac-auth-design.md` (Phase 2 of §0; schema in §5.1/§5.3; resolution in §6; caching in §7; catalogue in §9)

**Prior work:** `docs/superpowers/plans/2026-08-16-auth-phase-1.md` — already executed. `AuthGuard`, JWT verification, JIT provisioning, `@Public()`/`@CurrentUser()`, and `GET /me` all exist and work today. This plan builds on top of that live code, not the plan document — in particular, the Phase 1 plan doc still says role `MEMBER`; the actual codebase already renamed it to `CLIENT` (commit `804b2a3`) and added `heightCm`/`weightKg` to `User`. This plan uses the real current state.

## Global Constraints

- Server TypeScript is `strict` with `noFallthroughCasesInSwitch`. Env vars are read with bracket access — `process.env['KEY']` — to satisfy it. (Not touched by this plan — no new env vars.)
- Prettier is authoritative from the repo root: single quotes, trailing commas, 100 columns, LF.
- Prisma is folder-based: `prisma.schema = "prisma/schema"`. `schema.prisma` holds only generator + datasource; every model goes in its own `.prisma` file. Enums share `enums.prisma` (existing convention: `Role` and `UserStatus` already live there together).
- Controllers return plain data. `TransformInterceptor` wraps success as `{ success: true, data }`; `HttpExceptionFilter` renders failure as `{ success: false, error: { code, message } }`.
- Every endpoint with a request body needs a class-validator DTO (`ValidationPipe` runs `whitelist` + `forbidNonWhitelisted`). Not triggered by this plan — every new/changed endpoint here is a `GET`.
- Roles are `CLIENT | FRONT_DESK | COACH | ADMIN | DEV`. `DEV` is never assignable through the API and is never seeded a `RolePermission` row — it bypasses the catalogue entirely in code (§6 of the spec).
- `Permission` and `RolePermission` rows are seed-managed only — nothing in this phase writes to them from an HTTP request. Admin mutation endpoints (`PUT /admin/roles/:role/permissions`, etc.) are Phase 4.
- `server/.env` already points at a real, migrated Supabase project (confirmed via `npx prisma migrate status` → "Database schema is up to date!"). This plan's migration and seed commands run against that project, same as Phase 1's did.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `server/prisma/schema/permission.prisma` | `Permission` model — the catalogue |
| `server/prisma/schema/role-permission.prisma` | `RolePermission` model — role → permission grants |
| `server/prisma/seed.ts` | Idempotently seeds the catalogue and role grants from the registry |
| `server/src/rbac/rbac.types.ts` | `EffectivePermission` |
| `server/src/rbac/permission-registry.ts` | Canonical catalogue + role→permission grant map |
| `server/src/rbac/permissions.service.ts` | Resolves and caches a user's effective permissions |
| `server/src/rbac/decorators/require-permission.decorator.ts` | `@RequirePermission(key)` |
| `server/src/rbac/permissions.guard.ts` | Global guard enforcing `@RequirePermission` |
| `server/src/rbac/admin-permissions.controller.ts` | `GET /admin/permissions` — first protected endpoint |
| `server/src/rbac/rbac.module.ts` | Wires the above |

**Modified**

| File | Change |
|---|---|
| `server/prisma/schema/enums.prisma` | Add `PermissionScope` |
| `server/package.json` | Add `prisma.seed` and a `db:seed` script |
| `server/src/app.module.ts` | Import `RbacModule`; register `PermissionsGuard` as a second `APP_GUARD` |
| `server/src/users/users.module.ts` | Import `RbacModule` |
| `server/src/users/users.controller.ts` | `GET /me` includes effective permissions |
| `server/src/users/users.controller.spec.ts` | Updated for the new constructor dependency and response shape |

---

### Task 1: Prisma schema — `PermissionScope`, `Permission`, `RolePermission`

**Files:**
- Modify: `server/prisma/schema/enums.prisma`
- Create: `server/prisma/schema/permission.prisma`
- Create: `server/prisma/schema/role-permission.prisma`

**Interfaces:**
- Consumes: nothing
- Produces: Prisma `PermissionScope` enum; `Permission` and `RolePermission` models, generated onto `@prisma/client`

- [ ] **Step 1: Add `PermissionScope` to the enums file**

Append to `server/prisma/schema/enums.prisma`:

```prisma

// A permission's reach: OWN = only the caller's own rows, ALL = every row.
// Enforcement (scopeFilter) lands in Phase 3 — RolePermission stores scope
// starting now so Phase 3 needs no migration to add it.
enum PermissionScope {
  OWN
  ALL
}
```

- [ ] **Step 2: Write the `Permission` model**

Create `server/prisma/schema/permission.prisma`:

```prisma
// The permission catalogue. Rows are seeded from
// server/src/rbac/permission-registry.ts by prisma/seed.ts and never
// created any other way — see §9 of the RBAC design doc.
model Permission {
  id          String   @id @default(uuid()) @db.Uuid
  key         String   @unique
  resource    String
  action      String
  description String
  isDangerous Boolean  @default(false)
  requires    String[] @default([])

  rolePermissions RolePermission[]

  @@index([resource])
}
```

- [ ] **Step 3: Write the `RolePermission` model**

Create `server/prisma/schema/role-permission.prisma`:

```prisma
// Default permission grants per role. DEV holds no rows here — it bypasses
// the catalogue entirely in PermissionsService, per §6 of the RBAC design.
model RolePermission {
  id           String          @id @default(uuid()) @db.Uuid
  role         Role
  permissionId String          @db.Uuid
  scope        PermissionScope @default(OWN)

  permission Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)

  @@unique([role, permissionId])
  @@index([role])
}
```

- [ ] **Step 4: Generate the client and run the migration**

```bash
cd server
npx prisma generate
npx prisma migrate dev --name add_permission_catalogue
```

Expected: a new folder under `server/prisma/schema/migrations/`, and `Your database is now in sync with your schema.` This applies to the real Supabase project configured in `server/.env` — the same one Phase 1's migrations already ran against.

- [ ] **Step 5: Verify the client exposes the new models**

```bash
node -e "const {PrismaClient}=require('@prisma/client'); const p=new PrismaClient(); console.log(typeof p.permission.findMany, typeof p.rolePermission.findMany)"
```

Expected: `function function`

- [ ] **Step 6: Commit**

```bash
git add server/prisma
git commit -m "feat: add Permission and RolePermission tables"
```

---

### Task 2: Permission catalogue and role-grant registry

Pure data and a pure splitting function — no I/O, no Nest, cheap to test exhaustively.

**Files:**
- Create: `server/src/rbac/permission-registry.ts`
- Create: `server/src/rbac/permission-registry.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface PermissionDefinition { key: string; resource: string; action: string; description: string; isDangerous: boolean; requires: string[] }`
  - `deriveResourceAction(key: string): { resource: string; action: string }`
  - `PERMISSION_CATALOGUE: PermissionDefinition[]`
  - `ROLE_PERMISSIONS: Record<Exclude<Role, 'DEV'>, Array<{ key: string; scope: PermissionScope }>>`

- [ ] **Step 1: Write the failing test**

Create `server/src/rbac/permission-registry.spec.ts`:

```ts
import { PERMISSION_CATALOGUE, ROLE_PERMISSIONS, deriveResourceAction } from './permission-registry';

describe('deriveResourceAction', () => {
  it('splits a two-part key on its only dot', () => {
    expect(deriveResourceAction('member.read')).toEqual({ resource: 'member', action: 'read' });
  });

  it('splits a three-part key on the first and last dot', () => {
    expect(deriveResourceAction('checkin.station_token.issue')).toEqual({
      resource: 'checkin',
      action: 'issue',
    });
  });
});

describe('PERMISSION_CATALOGUE', () => {
  const keys = new Set(PERMISSION_CATALOGUE.map((p) => p.key));

  it('has no duplicate keys', () => {
    expect(keys.size).toBe(PERMISSION_CATALOGUE.length);
  });

  it('every requires entry points at a real catalogue key', () => {
    for (const def of PERMISSION_CATALOGUE) {
      for (const req of def.requires) {
        expect(keys.has(req)).toBe(true);
      }
    }
  });

  it('resource/action match what deriveResourceAction produces from the key', () => {
    for (const def of PERMISSION_CATALOGUE) {
      expect(deriveResourceAction(def.key)).toEqual({ resource: def.resource, action: def.action });
    }
  });
});

describe('ROLE_PERMISSIONS', () => {
  const catalogueKeys = new Set(PERMISSION_CATALOGUE.map((p) => p.key));

  it('does not seed DEV — it bypasses the catalogue entirely', () => {
    expect(Object.keys(ROLE_PERMISSIONS)).not.toContain('DEV');
  });

  it('every granted key exists in the catalogue', () => {
    for (const grants of Object.values(ROLE_PERMISSIONS)) {
      for (const grant of grants) {
        expect(catalogueKeys.has(grant.key)).toBe(true);
      }
    }
  });

  it('grants no role the same key twice', () => {
    for (const grants of Object.values(ROLE_PERMISSIONS)) {
      const grantKeys = grants.map((g) => g.key);
      expect(new Set(grantKeys).size).toBe(grantKeys.length);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test --workspace=server -- permission-registry
```

Expected: FAIL — `Cannot find module './permission-registry'`

- [ ] **Step 3: Write the registry**

Create `server/src/rbac/permission-registry.ts`:

```ts
import type { PermissionScope, Role } from '@prisma/client';

export interface PermissionDefinition {
  key: string;
  resource: string;
  action: string;
  description: string;
  isDangerous: boolean;
  requires: string[];
}

/**
 * Splits a permission key into its resource and action.
 *
 * Keys are `resource.action` or `resource.sub.action` — the resource is
 * everything before the first dot, the action is everything after the last.
 */
export function deriveResourceAction(key: string): { resource: string; action: string } {
  const parts = key.split('.');
  return { resource: parts[0], action: parts[parts.length - 1] };
}

function define(
  key: string,
  description: string,
  options: { isDangerous?: boolean; requires?: string[] } = {},
): PermissionDefinition {
  const { resource, action } = deriveResourceAction(key);
  return {
    key,
    resource,
    action,
    description,
    isDangerous: options.isDangerous ?? false,
    requires: options.requires ?? [],
  };
}

/**
 * The canonical permission catalogue — seeded into the database by
 * `prisma/seed.ts` and never created any other way. See §9 of the RBAC
 * design doc.
 *
 * `ai.*` keys are reserved for the AI fitness assistant, which has not
 * shipped yet — seeding them now means the assistant attaches to an
 * existing permission surface instead of inventing one later.
 */
export const PERMISSION_CATALOGUE: PermissionDefinition[] = [
  define('member.read', 'View member profiles'),
  define('member.create', 'Create a member', { requires: ['member.read'] }),
  define('member.update', 'Edit a member profile', { requires: ['member.read'] }),
  define('member.suspend', 'Suspend a member account', { requires: ['member.read'] }),
  define('member.delete', 'Delete a member', { isDangerous: true, requires: ['member.read'] }),

  define('checkin.self', 'Check in by scanning the counter QR'),
  define('checkin.read', 'View check-in records'),
  define('checkin.create', 'Check a member in manually', { requires: ['checkin.read'] }),
  define('checkin.station_token.issue', 'Render the counter check-in QR'),

  define('coach.read', 'View coach assignments'),
  define('coach.assign', 'Assign a member to a coach', { requires: ['coach.read'] }),
  define('coach.update', 'Edit a coach assignment', { requires: ['coach.read'] }),

  define('permission.read', 'View permission grants'),
  define('permission.grant', 'Grant a permission', {
    isDangerous: true,
    requires: ['permission.read'],
  }),
  define('permission.revoke', 'Revoke a permission', { requires: ['permission.read'] }),

  define('role.read', 'View roles'),
  define('role.change', 'Change the role assigned to a user', {
    isDangerous: true,
    requires: ['role.read'],
  }),
  define('role.permissions.update', 'Edit a role default permissions', {
    requires: ['role.read', 'permission.read'],
  }),

  define('announcement.read', 'View announcements'),
  define('announcement.create', 'Post an announcement', { requires: ['announcement.read'] }),
  define('announcement.update', 'Edit an announcement', { requires: ['announcement.read'] }),
  define('announcement.delete', 'Delete an announcement', { requires: ['announcement.read'] }),

  define('audit.read', 'View the audit log'),

  define('ai.chat.use', 'Use the AI fitness assistant'),
  define('ai.chat.history.read', 'View AI assistant conversation history'),
  define('ai.admin.configure', 'Configure the AI assistant'),
];

/**
 * One row per (role, permission) default grant. `DEV` is deliberately
 * absent — it bypasses the catalogue entirely in `PermissionsService`
 * rather than being seeded, per §6 of the RBAC design.
 *
 * This mapping is this plan's own interpretation of each role's surface —
 * the spec fixes the catalogue keys but not this table. Adjust freely; the
 * mechanism (PermissionsService, PermissionsGuard) does not depend on the
 * specific grants below.
 */
export const ROLE_PERMISSIONS: Record<
  Exclude<Role, 'DEV'>,
  Array<{ key: string; scope: PermissionScope }>
> = {
  CLIENT: [
    { key: 'checkin.self', scope: 'OWN' },
    { key: 'ai.chat.use', scope: 'OWN' },
    { key: 'ai.chat.history.read', scope: 'OWN' },
    { key: 'announcement.read', scope: 'ALL' },
  ],
  FRONT_DESK: [
    { key: 'checkin.read', scope: 'ALL' },
    { key: 'checkin.create', scope: 'ALL' },
    { key: 'checkin.station_token.issue', scope: 'ALL' },
    { key: 'member.read', scope: 'ALL' },
    { key: 'announcement.read', scope: 'ALL' },
  ],
  COACH: [
    { key: 'member.read', scope: 'OWN' },
    { key: 'coach.read', scope: 'OWN' },
    { key: 'checkin.read', scope: 'OWN' },
    { key: 'announcement.read', scope: 'ALL' },
    { key: 'ai.chat.history.read', scope: 'OWN' },
  ],
  ADMIN: [
    { key: 'member.read', scope: 'ALL' },
    { key: 'member.create', scope: 'ALL' },
    { key: 'member.update', scope: 'ALL' },
    { key: 'member.suspend', scope: 'ALL' },
    { key: 'member.delete', scope: 'ALL' },
    { key: 'checkin.read', scope: 'ALL' },
    { key: 'checkin.create', scope: 'ALL' },
    { key: 'checkin.station_token.issue', scope: 'ALL' },
    { key: 'coach.read', scope: 'ALL' },
    { key: 'coach.assign', scope: 'ALL' },
    { key: 'coach.update', scope: 'ALL' },
    { key: 'permission.read', scope: 'ALL' },
    { key: 'permission.grant', scope: 'ALL' },
    { key: 'permission.revoke', scope: 'ALL' },
    { key: 'role.read', scope: 'ALL' },
    { key: 'role.change', scope: 'ALL' },
    { key: 'role.permissions.update', scope: 'ALL' },
    { key: 'announcement.read', scope: 'ALL' },
    { key: 'announcement.create', scope: 'ALL' },
    { key: 'announcement.update', scope: 'ALL' },
    { key: 'announcement.delete', scope: 'ALL' },
    { key: 'audit.read', scope: 'ALL' },
    { key: 'ai.chat.history.read', scope: 'ALL' },
    { key: 'ai.admin.configure', scope: 'ALL' },
  ],
};
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
npm test --workspace=server -- permission-registry
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/rbac/permission-registry.ts server/src/rbac/permission-registry.spec.ts
git commit -m "feat: add the permission catalogue and role-grant registry"
```

---

### Task 3: Seed script

**Files:**
- Create: `server/prisma/seed.ts`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: `PERMISSION_CATALOGUE`, `ROLE_PERMISSIONS` (Task 2)
- Produces: populated `Permission` and `RolePermission` tables

- [ ] **Step 1: Write the seed script**

Create `server/prisma/seed.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import { PERMISSION_CATALOGUE, ROLE_PERMISSIONS } from '../src/rbac/permission-registry';

const prisma = new PrismaClient();

/**
 * Idempotent: safe to run against a database that already has some or all
 * of these rows. Keyed on `Permission.key` and the `(role, permissionId)`
 * unique constraint, so re-running after editing the registry updates
 * existing rows in place rather than duplicating them.
 */
async function main(): Promise<void> {
  for (const def of PERMISSION_CATALOGUE) {
    await prisma.permission.upsert({
      where: { key: def.key },
      update: {
        description: def.description,
        isDangerous: def.isDangerous,
        requires: def.requires,
      },
      create: {
        key: def.key,
        resource: def.resource,
        action: def.action,
        description: def.description,
        isDangerous: def.isDangerous,
        requires: def.requires,
      },
    });
  }
  console.info(`Seeded ${PERMISSION_CATALOGUE.length} permissions.`);

  const roles = Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>;
  let grantCount = 0;

  for (const role of roles) {
    for (const grant of ROLE_PERMISSIONS[role]) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { key: grant.key } });
      await prisma.rolePermission.upsert({
        where: { role_permissionId: { role, permissionId: permission.id } },
        update: { scope: grant.scope },
        create: { role, permissionId: permission.id, scope: grant.scope },
      });
      grantCount += 1;
    }
  }
  console.info(`Seeded ${grantCount} role permission grants.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

- [ ] **Step 2: Wire the seed command into `server/package.json`**

Add a top-level `"seed"` key inside the existing `"prisma"` block, and a convenience script.

```json
  "prisma": {
    "schema": "prisma/schema",
    "seed": "ts-node --transpile-only prisma/seed.ts"
  },
```

In `"scripts"`, add:

```json
    "db:seed": "prisma db seed",
```

- [ ] **Step 3: Run the seed against the configured database**

```bash
cd server
npm run db:seed
```

Expected: `Seeded 26 permissions.` and `Seeded 38 role permission grants.` with no errors.

- [ ] **Step 4: Verify the rows landed**

```bash
node -e "
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
p.permission.count().then((n)=>p.rolePermission.count().then((m)=>{console.log('permissions:',n,'rolePermissions:',m);return p.\$disconnect();}));
"
```

Expected: `permissions: 26 rolePermissions: 38`

- [ ] **Step 5: Commit**

```bash
git add server/prisma/seed.ts server/package.json
git commit -m "feat: seed the permission catalogue and role grants"
```

---

### Task 4: `PermissionsService` — resolution and caching

**Files:**
- Create: `server/src/rbac/rbac.types.ts`
- Create: `server/src/rbac/permissions.service.ts`
- Create: `server/src/rbac/permissions.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (existing), `AuthUser` (existing, `server/src/auth/auth.types.ts`)
- Produces:
  - `interface EffectivePermission { key: string; scope: PermissionScope }`
  - `PermissionsService.getEffectivePermissions(user: Pick<AuthUser, 'id' | 'role' | 'permissionVersion'>): Promise<EffectivePermission[]>`
  - `PermissionsService.hasPermission(user: Pick<AuthUser, 'id' | 'role' | 'permissionVersion'>, key: string): Promise<boolean>`

- [ ] **Step 1: Define the type**

Create `server/src/rbac/rbac.types.ts`:

```ts
import type { PermissionScope } from '@prisma/client';

/** One permission this user effectively holds, and at what row-level reach. */
export interface EffectivePermission {
  key: string;
  scope: PermissionScope;
}
```

- [ ] **Step 2: Write the failing test**

Create `server/src/rbac/permissions.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsService } from './permissions.service';

const CLIENT_USER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', role: 'CLIENT' as const, permissionVersion: 0 };
const DEV_USER = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', role: 'DEV' as const, permissionVersion: 0 };

describe('PermissionsService', () => {
  let service: PermissionsService;
  let findManyRolePermission: jest.Mock;
  let findManyPermission: jest.Mock;

  beforeEach(async () => {
    findManyRolePermission = jest.fn().mockResolvedValue([
      { scope: 'OWN', permission: { key: 'checkin.self' } },
      { scope: 'ALL', permission: { key: 'announcement.read' } },
    ]);
    findManyPermission = jest.fn().mockResolvedValue([{ key: 'member.read' }, { key: 'role.change' }]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        PermissionsService,
        {
          provide: PrismaService,
          useValue: {
            rolePermission: { findMany: findManyRolePermission },
            permission: { findMany: findManyPermission },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(PermissionsService);
  });

  it("resolves a role user's permissions from RolePermission", async () => {
    await expect(service.getEffectivePermissions(CLIENT_USER)).resolves.toEqual([
      { key: 'checkin.self', scope: 'OWN' },
      { key: 'announcement.read', scope: 'ALL' },
    ]);
    expect(findManyRolePermission).toHaveBeenCalledWith({
      where: { role: 'CLIENT' },
      select: { scope: true, permission: { select: { key: true } } },
    });
  });

  it('gives DEV every catalogue permission at scope ALL, bypassing RolePermission', async () => {
    await expect(service.getEffectivePermissions(DEV_USER)).resolves.toEqual([
      { key: 'member.read', scope: 'ALL' },
      { key: 'role.change', scope: 'ALL' },
    ]);
    expect(findManyRolePermission).not.toHaveBeenCalled();
  });

  it('caches by userId + permissionVersion, skipping the second DB call', async () => {
    await service.getEffectivePermissions(CLIENT_USER);
    await service.getEffectivePermissions(CLIENT_USER);
    expect(findManyRolePermission).toHaveBeenCalledTimes(1);
  });

  it('re-queries when permissionVersion changes', async () => {
    await service.getEffectivePermissions(CLIENT_USER);
    await service.getEffectivePermissions({ ...CLIENT_USER, permissionVersion: 1 });
    expect(findManyRolePermission).toHaveBeenCalledTimes(2);
  });

  describe('hasPermission', () => {
    it('is true for a granted key', async () => {
      await expect(service.hasPermission(CLIENT_USER, 'checkin.self')).resolves.toBe(true);
    });

    it('is false for a key not granted to the role', async () => {
      await expect(service.hasPermission(CLIENT_USER, 'member.delete')).resolves.toBe(false);
    });
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npm test --workspace=server -- permissions.service
```

Expected: FAIL — `Cannot find module './permissions.service'`

- [ ] **Step 4: Write the service**

Create `server/src/rbac/permissions.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type { EffectivePermission } from './rbac.types';

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  expiresAt: number;
  permissions: EffectivePermission[];
}

type PermissionUser = Pick<AuthUser, 'id' | 'role' | 'permissionVersion'>;

/**
 * Resolves a user's effective permissions and caches the result.
 *
 * Cache key is `{userId}:{permissionVersion}` — bumping permissionVersion
 * (any future role/permission change) yields a fresh key, so every server
 * instance self-invalidates with no pub/sub. See §7 of the RBAC design.
 *
 * Entries are evicted lazily (overwritten on the next lookup for that exact
 * key) rather than actively swept — fine at this app's user count; swap for
 * a bounded LRU before that stops being true.
 *
 * Phase 2 only: resolution is role permissions plus the DEV bypass.
 * Per-user overrides (UserPermission, DENY-beats-GRANT) land in Phase 3.
 */
@Injectable()
export class PermissionsService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  async getEffectivePermissions(user: PermissionUser): Promise<EffectivePermission[]> {
    const cacheKey = `${user.id}:${user.permissionVersion}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.permissions;
    }

    const permissions =
      user.role === 'DEV'
        ? await this.getAllCataloguePermissions()
        : await this.getRolePermissions(user.role);

    this.cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, permissions });
    return permissions;
  }

  async hasPermission(user: PermissionUser, key: string): Promise<boolean> {
    const permissions = await this.getEffectivePermissions(user);
    return permissions.some((permission) => permission.key === key);
  }

  /** DEV is a superuser escape hatch — every catalogue key, full reach. */
  private async getAllCataloguePermissions(): Promise<EffectivePermission[]> {
    const rows = await this.prisma.permission.findMany({ select: { key: true } });
    return rows.map((row) => ({ key: row.key, scope: 'ALL' as const }));
  }

  private async getRolePermissions(role: PermissionUser['role']): Promise<EffectivePermission[]> {
    const rows = await this.prisma.rolePermission.findMany({
      where: { role },
      select: { scope: true, permission: { select: { key: true } } },
    });
    return rows.map((row) => ({ key: row.permission.key, scope: row.scope }));
  }
}
```

- [ ] **Step 5: Run the tests and verify they pass**

```bash
npm test --workspace=server -- permissions.service
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/rbac/rbac.types.ts server/src/rbac/permissions.service.ts server/src/rbac/permissions.service.spec.ts
git commit -m "feat: resolve and cache effective permissions per user"
```

---

### Task 5: `@RequirePermission()` and `PermissionsGuard`

**Files:**
- Create: `server/src/rbac/decorators/require-permission.decorator.ts`
- Create: `server/src/rbac/permissions.guard.ts`
- Create: `server/src/rbac/permissions.guard.spec.ts`

**Interfaces:**
- Consumes: `PermissionsService` (Task 4), `IS_PUBLIC_KEY` (existing, `server/src/auth/decorators/public.decorator.ts`)
- Produces: `RequirePermission(key: string)`, `PermissionsGuard`

- [ ] **Step 1: Write the decorator**

Create `server/src/rbac/decorators/require-permission.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSION_KEY = 'requirePermission';

/** Requires the caller to hold this permission key. Runs after AuthGuard. */
export const RequirePermission = (key: string): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_PERMISSION_KEY, key);
```

- [ ] **Step 2: Write the failing guard test**

Create `server/src/rbac/permissions.guard.spec.ts`:

```ts
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { PermissionsService } from './permissions.service';
import type { AuthUser } from '../auth/auth.types';

const ACTIVE_USER: AuthUser = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  supabaseId: '11111111-1111-1111-1111-111111111111',
  email: 'juan@example.com',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  role: 'CLIENT',
  status: 'ACTIVE',
  permissionVersion: 0,
  heightCm: null,
  weightKg: null,
};

function contextWith(user?: AuthUser): { ctx: ExecutionContext; request: { user?: AuthUser } } {
  const request: { user?: AuthUser } = { user };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, request };
}

describe('PermissionsGuard', () => {
  let guard: PermissionsGuard;
  let hasPermission: jest.Mock;
  let isPublic: boolean;
  let requiredKey: string | undefined;

  beforeEach(() => {
    isPublic = false;
    requiredKey = undefined;
    hasPermission = jest.fn().mockResolvedValue(true);

    const reflector = {
      getAllAndOverride: (key: string) => (key === 'isPublic' ? isPublic : requiredKey),
    } as unknown as Reflector;

    guard = new PermissionsGuard(reflector, { hasPermission } as unknown as PermissionsService);
  });

  it('allows a route with no @RequirePermission', async () => {
    const { ctx } = contextWith(ACTIVE_USER);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(hasPermission).not.toHaveBeenCalled();
  });

  it('allows a @Public() route without checking permissions', async () => {
    isPublic = true;
    requiredKey = 'member.delete';
    const { ctx } = contextWith(undefined);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(hasPermission).not.toHaveBeenCalled();
  });

  it('allows a user who holds the required permission', async () => {
    requiredKey = 'checkin.self';
    const { ctx } = contextWith(ACTIVE_USER);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(hasPermission).toHaveBeenCalledWith(ACTIVE_USER, 'checkin.self');
  });

  it('rejects a user who lacks the required permission', async () => {
    requiredKey = 'member.delete';
    hasPermission.mockResolvedValue(false);
    const { ctx } = contextWith(ACTIVE_USER);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('throws if used on a route AuthGuard did not populate', async () => {
    requiredKey = 'checkin.self';
    const { ctx } = contextWith(undefined);
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      '@RequirePermission() used on a route that AuthGuard did not populate',
    );
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npm test --workspace=server -- permissions.guard
```

Expected: FAIL — `Cannot find module './permissions.guard'`

- [ ] **Step 4: Write the guard**

Create `server/src/rbac/permissions.guard.ts`:

```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { REQUIRE_PERMISSION_KEY } from './decorators/require-permission.decorator';
import { PermissionsService } from './permissions.service';
import type { AuthUser } from '../auth/auth.types';

/**
 * Enforces `@RequirePermission()`. Registered globally as the second
 * APP_GUARD, after AuthGuard — a route with no requirement is unaffected,
 * and a @Public() route is skipped since AuthGuard never populated
 * `request.user` for it.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredKey = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredKey) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    if (!request.user) {
      throw new Error('@RequirePermission() used on a route that AuthGuard did not populate');
    }

    const allowed = await this.permissions.hasPermission(request.user, requiredKey);
    if (!allowed) {
      throw new ForbiddenException(`Missing required permission: ${requiredKey}`);
    }

    return true;
  }
}
```

- [ ] **Step 5: Run the tests and verify they pass**

```bash
npm test --workspace=server -- permissions.guard
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/rbac/decorators server/src/rbac/permissions.guard.ts server/src/rbac/permissions.guard.spec.ts
git commit -m "feat: add @RequirePermission and the global PermissionsGuard"
```

---

### Task 6: Wire `RbacModule` into the app

**Files:**
- Create: `server/src/rbac/rbac.module.ts`
- Modify: `server/src/app.module.ts`
- Modify: `server/src/users/users.module.ts`

**Interfaces:**
- Consumes: `PermissionsService`, `PermissionsGuard` (Tasks 4–5)
- Produces: `RbacModule` (exports both); `PermissionsGuard` active globally as the second `APP_GUARD`

- [ ] **Step 1: Write `RbacModule`**

Create `server/src/rbac/rbac.module.ts`. It has no controller yet — Task 8 adds one and this file gets `controllers: [AdminPermissionsController]` then.

```ts
import { Module } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { PermissionsGuard } from './permissions.guard';

@Module({
  providers: [PermissionsService, PermissionsGuard],
  exports: [PermissionsService, PermissionsGuard],
})
export class RbacModule {}
```

- [ ] **Step 2: Import `RbacModule` into `AppModule` and register the second guard**

In `server/src/app.module.ts`, add the import:

```ts
import { RbacModule } from './rbac/rbac.module';
import { PermissionsGuard } from './rbac/permissions.guard';
```

Add `RbacModule` to `imports`, directly after `UsersModule`:

```ts
    AuthModule,
    UsersModule,
    RbacModule,
```

Add a second entry to `providers` — order matters, `AuthGuard` must run first so `request.user` exists before `PermissionsGuard` reads it:

```ts
  providers: [
    // Authentication runs on every route. Opt out per-endpoint with @Public().
    { provide: APP_GUARD, useClass: AuthGuard },
    // Runs after AuthGuard. Only enforces on routes carrying @RequirePermission().
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
```

- [ ] **Step 3: Let `UsersModule` see `PermissionsService`**

`UsersController` will depend on `PermissionsService` starting in Task 7. Import `RbacModule` now so that wiring is ready:

In `server/src/users/users.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [RbacModule],
  controllers: [UsersController],
})
export class UsersModule {}
```

- [ ] **Step 4: Verify the app still builds and the full suite passes**

```bash
npm run build:server
npm test --workspace=server
```

Expected: build succeeds; all suites pass (`UsersController` is untouched until Task 7, so its existing test still passes with the plain `new UsersController()` constructor call).

- [ ] **Step 5: Commit**

```bash
git add server/src/rbac/rbac.module.ts server/src/app.module.ts server/src/users/users.module.ts
git commit -m "feat: wire PermissionsGuard into the app as the second global guard"
```

---

### Task 7: `GET /me` reports effective permissions

**Files:**
- Modify: `server/src/users/users.controller.ts`
- Modify: `server/src/users/users.controller.spec.ts`

**Interfaces:**
- Consumes: `PermissionsService.getEffectivePermissions` (Task 4)
- Produces: `GET /api/v1/me` response gains a `permissions: EffectivePermission[]` field

- [ ] **Step 1: Update the controller test for the new dependency and field**

Replace the whole of `server/src/users/users.controller.spec.ts`:

```ts
import { UsersController } from './users.controller';
import { PermissionsService } from '../rbac/permissions.service';
import type { AuthUser } from '../auth/auth.types';

const USER: AuthUser = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  supabaseId: '11111111-1111-1111-1111-111111111111',
  email: 'juan@example.com',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  role: 'CLIENT',
  status: 'ACTIVE',
  permissionVersion: 3,
  heightCm: 175,
  weightKg: 72.4,
};

describe('UsersController', () => {
  const getEffectivePermissions = jest
    .fn()
    .mockResolvedValue([{ key: 'checkin.self', scope: 'OWN' }]);
  const controller = new UsersController({ getEffectivePermissions } as unknown as PermissionsService);

  it("returns the current user's profile with effective permissions", async () => {
    await expect(controller.me(USER)).resolves.toEqual({
      id: USER.id,
      email: USER.email,
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      role: 'CLIENT',
      status: 'ACTIVE',
      heightCm: 175,
      weightKg: 72.4,
      permissions: [{ key: 'checkin.self', scope: 'OWN' }],
    });
    expect(getEffectivePermissions).toHaveBeenCalledWith(USER);
  });

  it('does not leak supabaseId or permissionVersion to the client', async () => {
    const body = (await controller.me(USER)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('supabaseId');
    expect(body).not.toHaveProperty('permissionVersion');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test --workspace=server -- users.controller
```

Expected: FAIL — the current `UsersController` takes no constructor argument and `me()` is synchronous, so `controller.me(USER)` is not a thenable / the mismatched call signature errors.

- [ ] **Step 3: Update the controller**

Replace the whole of `server/src/users/users.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PermissionsService } from '../rbac/permissions.service';
import type { AuthUser } from '../auth/auth.types';
import type { EffectivePermission } from '../rbac/rbac.types';

interface MeResponse {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  heightCm: number | null;
  weightKg: number | null;
  permissions: EffectivePermission[];
}

@Controller('me')
export class UsersController {
  constructor(private readonly permissions: PermissionsService) {}

  /**
   * The authenticated user's own profile plus effective permissions.
   *
   * Returns plain data — TransformInterceptor wraps it as { success, data }.
   *
   * supabaseId and permissionVersion are internal and deliberately omitted:
   * the first is an identifier for another system, the second is a cache
   * mechanism. Neither is any of the browser's business.
   */
  @Get()
  async me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    const permissions = await this.permissions.getEffectivePermissions(user);

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      status: user.status,
      // Safe here — /me is the caller's own record. These must never appear
      // in any endpoint that lists users to somebody else.
      heightCm: user.heightCm,
      weightKg: user.weightKg,
      permissions,
    };
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
npm test --workspace=server -- users.controller
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/users/users.controller.ts server/src/users/users.controller.spec.ts
git commit -m "feat: include effective permissions in GET /me"
```

---

### Task 8: `GET /admin/permissions` — the first protected endpoint

**Files:**
- Create: `server/src/rbac/admin-permissions.controller.ts`
- Create: `server/src/rbac/admin-permissions.controller.spec.ts`
- Modify: `server/src/rbac/rbac.module.ts`

**Interfaces:**
- Consumes: `PERMISSION_CATALOGUE` (Task 2), `RequirePermission` (Task 5)
- Produces: `GET /api/v1/admin/permissions`, gated on `permission.read`

- [ ] **Step 1: Write the failing test**

Create `server/src/rbac/admin-permissions.controller.spec.ts`:

```ts
import { AdminPermissionsController, groupByResource } from './admin-permissions.controller';
import { PERMISSION_CATALOGUE } from './permission-registry';

describe('groupByResource', () => {
  it('groups catalogue entries by resource', () => {
    const grouped = groupByResource([
      {
        key: 'member.read',
        resource: 'member',
        action: 'read',
        description: 'x',
        isDangerous: false,
        requires: [],
      },
      {
        key: 'member.create',
        resource: 'member',
        action: 'create',
        description: 'y',
        isDangerous: false,
        requires: [],
      },
      {
        key: 'coach.read',
        resource: 'coach',
        action: 'read',
        description: 'z',
        isDangerous: false,
        requires: [],
      },
    ]);

    expect(Object.keys(grouped).sort()).toEqual(['coach', 'member']);
    expect(grouped['member']).toHaveLength(2);
    expect(grouped['coach']).toHaveLength(1);
  });
});

describe('AdminPermissionsController', () => {
  it('returns the full catalogue grouped by resource', () => {
    const controller = new AdminPermissionsController();
    const result = controller.list();
    const flatCount = Object.values(result).reduce((sum, entries) => sum + entries.length, 0);
    expect(flatCount).toBe(PERMISSION_CATALOGUE.length);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test --workspace=server -- admin-permissions.controller
```

Expected: FAIL — `Cannot find module './admin-permissions.controller'`

- [ ] **Step 3: Write the controller**

Create `server/src/rbac/admin-permissions.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from './decorators/require-permission.decorator';
import { PERMISSION_CATALOGUE } from './permission-registry';
import type { PermissionDefinition } from './permission-registry';

export type PermissionCatalogueResponse = Record<string, PermissionDefinition[]>;

/** Groups the catalogue by resource, e.g. `{ member: [...], coach: [...] }`. */
export function groupByResource(catalogue: PermissionDefinition[]): PermissionCatalogueResponse {
  const grouped: PermissionCatalogueResponse = {};
  for (const entry of catalogue) {
    (grouped[entry.resource] ??= []).push(entry);
  }
  return grouped;
}

@Controller('admin/permissions')
export class AdminPermissionsController {
  /**
   * The full permission catalogue, grouped by resource.
   *
   * Static — this reads the hard-coded registry, not the database. It is
   * the first endpoint this app protects with @RequirePermission, proving
   * the AuthGuard → PermissionsGuard → PermissionsService path end to end.
   */
  @Get()
  @RequirePermission('permission.read')
  list(): PermissionCatalogueResponse {
    return groupByResource(PERMISSION_CATALOGUE);
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
npm test --workspace=server -- admin-permissions.controller
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Register the controller on `RbacModule`**

Update `server/src/rbac/rbac.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { PermissionsGuard } from './permissions.guard';
import { AdminPermissionsController } from './admin-permissions.controller';

@Module({
  controllers: [AdminPermissionsController],
  providers: [PermissionsService, PermissionsGuard],
  exports: [PermissionsService, PermissionsGuard],
})
export class RbacModule {}
```

- [ ] **Step 6: Verify the whole suite passes and the app builds**

```bash
npm test --workspace=server
npm run build:server
```

Expected: all suites pass; build emits with no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/rbac/admin-permissions.controller.ts server/src/rbac/admin-permissions.controller.spec.ts server/src/rbac/rbac.module.ts
git commit -m "feat: add GET /admin/permissions, gated on permission.read"
```

---

### Task 9: End-to-end verification

No new files — this confirms the guard chain actually works against the real database, the way Phase 1's Task 7 Step 9 did for authentication.

- [ ] **Step 1: Start the server**

```bash
npm run dev:server
```

- [ ] **Step 2: Confirm an authenticated CLIENT is rejected**

Register or sign in through the client app to get a real Supabase access token for an ordinary account (fresh sign-ups default to `role = CLIENT`), then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <client-token>" \
  http://localhost:4000/api/v1/admin/permissions
```

Expected: `403` — a `CLIENT` was never granted `permission.read`.

- [ ] **Step 3: Confirm `GET /me` now includes permissions**

```bash
curl -s -H "Authorization: Bearer <client-token>" http://localhost:4000/api/v1/me | node -e "process.stdin.once('data', d => console.log(JSON.parse(d).data.permissions))"
```

Expected: an array including `{ key: 'checkin.self', scope: 'OWN' }`.

- [ ] **Step 4: Promote that account to ADMIN directly in the database**

Roles are DB-only by design (§10 of the spec — no self-promotion through the API). Use Prisma Studio:

```bash
cd server
npx prisma studio
```

Open `User`, find the row by email, set `role` to `ADMIN`, save.

- [ ] **Step 5: Confirm the same token now succeeds**

Sign out and back in on the client (so the browser has a fresh token — the JWT itself does not carry role, so no new token is strictly required, but a fresh `/me` call re-reads the DB row regardless):

```bash
curl -s http://localhost:4000/api/v1/admin/permissions | node -e "process.stdin.once('data', d => console.log(Object.keys(JSON.parse(d).data)))"
```

Expected: `200` with the catalogue grouped by resource, e.g. `['member','checkin','coach','permission','role','announcement','audit','ai']`.

- [ ] **Step 6: Confirm `@Public()` routes are unaffected**

```bash
curl -s http://localhost:4000/api/health
```

Expected: `{"success":true,"data":{...}}` — unchanged from before this phase.

---

## Done when

- `npm test --workspace=server` passes, including this plan's new tests (8 registry, 6 permissions service, 5 permissions guard, 2 admin-permissions controller, 2 updated users controller — 23 new/changed tests) alongside every pre-existing suite
- `npm run build` succeeds for all three workspaces
- `Permission` and `RolePermission` are seeded (26 permissions, 38 grants across `CLIENT`/`FRONT_DESK`/`COACH`/`ADMIN`) and `DEV` holds no rows but resolves every catalogue key
- `GET /admin/permissions` returns `403` for a `CLIENT` and `200` (catalogue grouped by resource) for an `ADMIN`
- `GET /me` includes the caller's effective permissions
- `GET /api/health` still responds without a token — Phase 1 behavior is unchanged

## Not in this phase

Deliberately absent, each landing in a later phase of the spec (`docs/superpowers/specs/2026-08-16-rbac-auth-design.md`, §0): `UserPermission` overrides and the GRANT/DENY resolution in §6, `scopeFilter` / row-level `OWN` vs `ALL` enforcement, `CoachAssignment`, prerequisite enforcement on grant/revoke, the mutating admin API (`PATCH /admin/users/:id/role`, `PUT /admin/roles/:role/permissions`, etc.), `AuditLog`, and QR check-in. The `scope` column on `RolePermission` is stored starting now specifically so none of that needs a migration later.
