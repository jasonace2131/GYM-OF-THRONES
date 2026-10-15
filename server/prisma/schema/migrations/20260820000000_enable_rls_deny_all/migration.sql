-- Lock every application table against Supabase's public REST API.
--
-- Prisma creates plain Postgres tables. Supabase only enables row-level
-- security on tables made through its own dashboard, so every table this
-- project migrated in was left "Unrestricted" — and Supabase's default grants
-- give the `anon` and `authenticated` roles SELECT, INSERT, UPDATE, DELETE and
-- TRUNCATE across the public schema.
--
-- `anon` is the key compiled into the browser bundle. It is public by design.
-- The combination meant anyone could read Payment and User, or TRUNCATE the
-- database, straight through https://<ref>.supabase.co/rest/v1/<table> —
-- bypassing the API, AuthGuard, PermissionsGuard and every scope filter.
-- Verified live before this migration: an anon-key GET on "User" returned rows.
-- Verified after: the same request returns 401 permission denied.
--
-- ENABLE (not FORCE) is deliberate. With RLS on and no policy defined, Postgres
-- denies every row to ordinary roles, which is what we want for anon and
-- authenticated. The application connects as `postgres`, which has BYPASSRLS,
-- so the server is unaffected and needs no policies. FORCE would apply RLS to
-- the table owner too and would break the server.
--
-- Authorization deliberately lives in NestJS, not in policies: the scope
-- contract, the 404-not-403 rule and the permission catalogue are enforced and
-- tested there. This migration's only job is to stop a second, unguarded door
-- existing beside them.

ALTER TABLE "User"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Permission"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RolePermission"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachAssignment"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdempotencyRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Plan"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Membership"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MembershipEvent"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MembershipHold"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payment"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Shift"             ENABLE ROW LEVEL SECURITY;

-- Defence in depth: nothing outside the server has any business holding write
-- grants on these tables.
--
-- Guarded because `anon` and `authenticated` are Supabase's roles and do not
-- exist in a plain Postgres instance. The e2e harness builds its database from
-- these same migrations in a bare container, where an unguarded REVOKE fails
-- with 42704 and takes the whole suite down.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
  END IF;
END
$rls$;
