-- Edit role access (feat/role-access-editor, owner 2026-11-07). Hand-written.
--
-- The gym's own changes to each role's default grants. The code keeps the
-- defaults (ROLE_PERMISSIONS), this table keeps the differences, and
-- `prisma db seed` writes RolePermission = defaults + these rows, so a deploy
-- no longer undoes an edit made on Staff & Access.
--
--   scope set  -> the role holds the key at that reach
--   scope NULL -> a default grant removed
--
-- ADDITIVE ONLY: one new table, empty. main's code never reads it, and with no
-- rows the new seed writes exactly what the old one did, so either version of
-- the code runs against this schema during the deploy window.

CREATE TABLE "RolePermissionOverride" (
    "id"           UUID              NOT NULL,
    "role"         "Role"            NOT NULL,
    "permissionId" UUID              NOT NULL,
    "scope"        "PermissionScope",
    "updatedById"  UUID,
    "updatedAt"    TIMESTAMPTZ(3)    NOT NULL,

    CONSTRAINT "RolePermissionOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RolePermissionOverride_role_permissionId_key"
    ON "RolePermissionOverride"("role", "permissionId");
CREATE INDEX "RolePermissionOverride_role_idx" ON "RolePermissionOverride"("role");

-- A permission the code drops takes the gym's changes to it along.
ALTER TABLE "RolePermissionOverride" ADD CONSTRAINT "RolePermissionOverride_permissionId_fkey"
    FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, like AssistantSettings: the change outlives the account that made it.
ALTER TABLE "RolePermissionOverride" ADD CONSTRAINT "RolePermissionOverride_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The Super Admin bypasses the grant tables; a row for it would read as a limit
-- that is not one. Lives only here: Prisma cannot represent a CHECK.
ALTER TABLE "RolePermissionOverride" ADD CONSTRAINT "RolePermissionOverride_not_dev"
    CHECK ("role" <> 'DEV');

-- Closed to Supabase's public REST API, like every table here
-- (20260820000000_enable_rls_deny_all). The server connects as `postgres`,
-- which bypasses RLS, so it needs no policy.
ALTER TABLE "RolePermissionOverride" ENABLE ROW LEVEL SECURITY;

-- Guarded: `anon` and `authenticated` do not exist in the plain Postgres the e2e
-- harness builds from these migrations.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "RolePermissionOverride" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "RolePermissionOverride" FROM authenticated';
  END IF;
END
$rls$;
