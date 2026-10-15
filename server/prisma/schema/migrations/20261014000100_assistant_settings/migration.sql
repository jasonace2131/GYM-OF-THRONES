-- The member assistant's editable instructions (feat/assistant-settings, 2026-10-14).
--
-- Hand-written: prisma migrate dev refuses on the shared dev DB (checksum drift).
-- ADDITIVE ONLY: one new table. main's code never reads it, so it keeps running
-- against this schema during the deploy window (migrate deploy runs first).
--
-- ONE ROW OR NONE. No row means the built-in default in
-- server/src/assistant/assistant-prompt.ts; "Reset to default" deletes the row.
-- The locked safety rules are never stored: code appends them to whatever is here.
--
-- Every CHECK below lives ONLY here — Prisma cannot represent them — so
-- test/assistant-settings-constraints.e2e-spec.ts asserts each name AND predicate.

CREATE TABLE "AssistantSettings" (
    "id"           INTEGER        NOT NULL DEFAULT 1,
    "instructions" TEXT           NOT NULL,
    "updatedById"  UUID,
    "updatedAt"    TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AssistantSettings_pkey" PRIMARY KEY ("id")
);

-- SET NULL, like GymHours: the instructions outlive the account that last saved them.
ALTER TABLE "AssistantSettings" ADD CONSTRAINT "AssistantSettings_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One row, ever.
ALTER TABLE "AssistantSettings" ADD CONSTRAINT "AssistantSettings_single_row"
    CHECK ("id" = 1);

-- Never blank, never longer than the editor allows. A blank row would hand the model
-- the safety rules alone, with no idea which gym it works for. The trim names tabs
-- and line breaks too: bare btrim() strips spaces only
-- (20261001000100_constraint_floor_fixes). char_length counts characters, not
-- bytes, so an emoji is one — the same count the DTO and the editor use.
ALTER TABLE "AssistantSettings" ADD CONSTRAINT "AssistantSettings_instructions_sane"
    CHECK (
      char_length(btrim("instructions", E' \t\r\n')) >= 1
      AND char_length("instructions") <= 6000
    );

-- Lock it like every other table (see 20261011000000_member_notices). Supabase's
-- default grants give `anon` and `authenticated` full DML across public; the
-- browser's only door is NestJS. ENABLE (not FORCE) leaves the server's BYPASSRLS
-- role unaffected.
ALTER TABLE "AssistantSettings" ENABLE ROW LEVEL SECURITY;

-- Guarded: `anon` and `authenticated` do not exist in the plain Postgres the e2e
-- harness builds from these migrations.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "AssistantSettings" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "AssistantSettings" FROM authenticated';
  END IF;
END
$rls$;
