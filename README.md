# 🐯 Gym of Thrones House of Fitness

Full-stack monorepo for the Gym of Thrones website.

## Tech Stack

| Package | Technology |
|---------|-----------|
| `client/` | Next.js 16 (App Router, TypeScript) |
| `server/` | NestJS 11 (TypeScript, Prisma) |
| `shared/` | Shared TypeScript types & constants |
| Database | PostgreSQL via Supabase + Prisma ORM |
| Deploy | Vercel (client) + Railway (server) |

## Getting Started

### Prerequisites
- Node.js >= 20
- npm >= 10
- A Supabase project (free tier works)

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables
```bash
# Copy the template and fill in your values
cp .env.example server/.env
cp .env.example client/.env.local
```

### 3. Generate the Prisma client and build the database
```bash
cd server
npx prisma generate
npx prisma migrate dev --name init
npm run db:seed --workspace=server
```

`db seed` is required, not optional, and must be re-run after every `migrate dev` / `migrate deploy`. It loads the permission catalogue and the per-role grants. Skip it and the app fails closed silently: every non-`DEV` role has zero permissions, so `/admin/permissions` returns 403 even for an ADMIN and `/me` returns `permissions: []` — no crash, just a silent lockout.

### 4. Run development servers
```bash
# Terminal 1 — Backend (http://localhost:4000)
npm run dev:server

# Terminal 2 — Frontend (http://localhost:3000)
npm run dev:client
```

### Verify
- Backend health: `GET http://localhost:4000/api/health`
- Frontend: `http://localhost:3000`

## Project Structure

```
gym-of-thrones/
├── client/     # Next.js frontend → deploys to Vercel
├── server/     # NestJS backend  → deploys to Railway
└── shared/     # Shared types    → consumed by both packages
```

## Module Ownership

| Module | Owner | Status |
|--------|-------|--------|
| Core Infrastructure (`PrismaModule`, `HealthModule`, config, filters, interceptors) | Lead | ✅ Complete |
| `AuthModule` — Supabase JWT verification, JIT provisioning, soft-delete rejection | Lead | ✅ Complete |
| `RbacModule` — permission catalogue, cache, `PermissionsGuard`, `scopeFilter` | Lead | ✅ Complete |
| `UsersModule` — `GET /me` | Lead | ✅ Complete |
| `CoachAssignmentsModule` — the reference scoped feature module | Lead | ✅ Chunk 0 |
| `SchedulerModule` — registry-driven cron jobs, `pruneEphemera` | Lead | ✅ Chunk 0 |
| `MembershipsModule`, `PaymentsModule`, `ShiftsModule`, `PlansModule` | — | 🔜 Chunk 1 |
| `CheckinModule`, `StationsModule`, `FrontDeskModule` | — | 🔜 Chunk 2 |
| Public Website | Dev B | 🔜 |
| Announcements | Dev C | 🔜 |

## API

Base URL: `http://localhost:4000/api/v1` (health is version-neutral at `/api/health`).

| Endpoint | Permission | Description |
|----------|------------|-------------|
| `GET /api/health` | public | Server health check (unthrottled) |
| `GET /me` | — | The caller's own profile and effective permissions |
| `GET /admin/permissions` | `permission.read` | The seeded permission catalogue |
| `GET /coach-assignments` | `coach.read` | Scoped list — a `COACH` at `OWN` sees only their own |
| `GET /coach-assignments/:id` | `coach.read` | 404, never 403, on a scoped miss |
| `POST /coach-assignments` | `coach.assign` | Assign or reassign; soft-ends the incumbent |
| `DELETE /coach-assignments/:id` | `coach.update` | Soft end; idempotent; returns the row |

Full route table for chunks 1–2: `docs/superpowers/specs/2026-08-18-membership-attendance-design.md` §7.7.
