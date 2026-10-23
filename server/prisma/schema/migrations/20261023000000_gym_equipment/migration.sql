-- The gym's equipment list (owner, 2026-10-23): edited in Admin → Settings,
-- read by the AI planners as data.
--
-- Hand-written: prisma migrate dev refuses on the shared dev DB (checksum drift).
-- ADDITIVE ONLY: one new table. main's code never reads it, so it keeps running
-- against this schema during the deploy window (migrate deploy runs first).
--
-- Every CHECK and the lower(name) unique index live ONLY here — Prisma cannot
-- represent them — so test/gym-equipment-constraints.e2e-spec.ts asserts each
-- name AND predicate.

CREATE TABLE "GymEquipment" (
    "id"        UUID           NOT NULL,
    "name"      TEXT           NOT NULL,
    "detail"    TEXT,
    "sortOrder" INTEGER        NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GymEquipment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GymEquipment_sortOrder_idx" ON "GymEquipment"("sortOrder");

-- "Dumbbells" and "dumbbells" are one item: the AI would read a duplicate as two.
CREATE UNIQUE INDEX "GymEquipment_name_lower_key" ON "GymEquipment" (lower("name"));

-- Never blank, never longer than the editor allows. The trim names tabs and line
-- breaks too: bare btrim() strips spaces only (20261001000100_constraint_floor_fixes).
-- char_length counts characters, the same count the DTO uses.
ALTER TABLE "GymEquipment" ADD CONSTRAINT "GymEquipment_name_sane"
    CHECK (
      char_length(btrim("name", E' \t\r\n')) >= 1
      AND char_length("name") <= 80
    );

-- Optional, but when set it says something and stays short.
ALTER TABLE "GymEquipment" ADD CONSTRAINT "GymEquipment_detail_sane"
    CHECK (
      "detail" IS NULL
      OR (char_length(btrim("detail", E' \t\r\n')) >= 1 AND char_length("detail") <= 120)
    );

ALTER TABLE "GymEquipment" ADD CONSTRAINT "GymEquipment_sortOrder_nonnegative"
    CHECK ("sortOrder" >= 0);

-- Lock it like every other table (see 20261011000000_member_notices). Supabase's
-- default grants give `anon` and `authenticated` full DML across public; the
-- browser's only door is NestJS. ENABLE (not FORCE) leaves the server's BYPASSRLS
-- role unaffected.
ALTER TABLE "GymEquipment" ENABLE ROW LEVEL SECURITY;

-- Guarded: `anon` and `authenticated` do not exist in the plain Postgres the e2e
-- harness builds from these migrations.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "GymEquipment" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "GymEquipment" FROM authenticated';
  END IF;
END
$rls$;
