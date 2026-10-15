-- Member workout planner (feat/member-workouts): a member's own AI plans, the one
-- in-flight draft that IS the generation job, the daily AI-action ledger, and the
-- shared "How to" cache.
--
-- Hand-written: prisma migrate dev refuses on the shared dev DB (checksum drift).
-- ADDITIVE ONLY: six new enums and four new tables. No existing enum or table is
-- altered, so main's code keeps running against this schema during the deploy window.
--
-- Every CHECK and the partial unique index below live ONLY here — Prisma cannot
-- represent them — so test/member-workouts-constraints.e2e-spec.ts asserts each
-- name AND predicate. A `db push` or a regenerated migration would drop them
-- silently while every service test kept passing.

-- ── Enums ─────────────────────────────────────────────────────────────────────────

CREATE TYPE "WorkoutGoal"        AS ENUM ('MUSCLE', 'FAT_LOSS', 'STRENGTH', 'ENDURANCE', 'GENERAL', 'SPORT');
CREATE TYPE "WorkoutExperience"  AS ENUM ('NEW', 'SOME', 'EXPERIENCED');
CREATE TYPE "WorkoutTimeOfDay"   AS ENUM ('MORNING', 'AFTERNOON', 'EVENING');
CREATE TYPE "WorkoutEasyOn"      AS ENUM ('KNEES', 'LOWER_BACK', 'SHOULDERS', 'WRISTS', 'NECK', 'HIPS');
CREATE TYPE "WorkoutPlanSource"  AS ENUM ('AI', 'EDITED');
CREATE TYPE "WorkoutDraftStatus" AS ENUM ('RUNNING', 'READY', 'FAILED');

-- ── MemberWorkoutPlan — a saved plan, up to five per member, one active ──────────

CREATE TABLE "MemberWorkoutPlan" (
    "id"              UUID                NOT NULL,
    "memberId"        UUID                NOT NULL,
    "name"            TEXT                NOT NULL,
    "goal"            "WorkoutGoal"       NOT NULL,
    "goalNotes"       TEXT,
    "experience"      "WorkoutExperience" NOT NULL,
    "weekdays"        SMALLINT[],
    "sessionMinutes"  SMALLINT            NOT NULL,
    "timeOfDay"       "WorkoutTimeOfDay"  NOT NULL,
    "healthFlag"      BOOLEAN             NOT NULL,
    "easyOn"          "WorkoutEasyOn"[],
    "useMeasurements" BOOLEAN             NOT NULL,
    "useAttendance"   BOOLEAN             NOT NULL,
    "useBookings"     BOOLEAN             NOT NULL,
    "body"            JSONB               NOT NULL,
    "source"          "WorkoutPlanSource" NOT NULL,
    "model"           TEXT,
    "isActive"        BOOLEAN             NOT NULL DEFAULT false,
    "consentAt"       TIMESTAMPTZ(3)      NOT NULL,
    "createdAt"       TIMESTAMPTZ(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMPTZ(3)      NOT NULL,

    CONSTRAINT "MemberWorkoutPlan_pkey" PRIMARY KEY ("id")
);

-- The library list: a member's plans, newest first.
CREATE INDEX "MemberWorkoutPlan_memberId_createdAt_idx" ON "MemberWorkoutPlan" ("memberId", "createdAt");

-- ONE ACTIVE PLAN PER MEMBER, as a database fact. Partial, so inactive plans do not
-- collide. Prisma has no representation for a partial index and will offer to drop
-- it on every `migrate diff` — the same known drift as StationScan_opening_checkin_once.
CREATE UNIQUE INDEX "MemberWorkoutPlan_one_active" ON "MemberWorkoutPlan" ("memberId") WHERE "isActive";

ALTER TABLE "MemberWorkoutPlan" ADD CONSTRAINT "MemberWorkoutPlan_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 1-60 characters and never only whitespace; the API trims and checks the same.
ALTER TABLE "MemberWorkoutPlan" ADD CONSTRAINT "MemberWorkoutPlan_name_length"
    CHECK (char_length(btrim("name")) >= 1 AND char_length("name") <= 60);

-- NULL means "no notes". Present means it says something, and fits the prompt.
ALTER TABLE "MemberWorkoutPlan" ADD CONSTRAINT "MemberWorkoutPlan_goalNotes_length"
    CHECK ("goalNotes" IS NULL OR (char_length(btrim("goalNotes")) >= 1 AND char_length("goalNotes") <= 300));

-- The wizard's four choices, and nothing in between.
ALTER TABLE "MemberWorkoutPlan" ADD CONSTRAINT "MemberWorkoutPlan_sessionMinutes"
    CHECK ("sessionMinutes" IN (30, 45, 60, 75));

-- 1-7 weekdays, each 0 (Sunday) to 6 (Saturday). Uniqueness is the API's rule.
ALTER TABLE "MemberWorkoutPlan" ADD CONSTRAINT "MemberWorkoutPlan_weekdays_shape"
    CHECK ("weekdays" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::SMALLINT[] AND cardinality("weekdays") BETWEEN 1 AND 7);

-- Six areas exist; more than six is a repeat.
ALTER TABLE "MemberWorkoutPlan" ADD CONSTRAINT "MemberWorkoutPlan_easyOn_size"
    CHECK (cardinality("easyOn") <= 6);

-- The full schema ({ summary, days: [...], guidance: [...] }) is validated by the API
-- on the model's reply, on the save and on every hand edit. This is the floor under
-- it: a body that is not an object with a days array is never a plan.
ALTER TABLE "MemberWorkoutPlan" ADD CONSTRAINT "MemberWorkoutPlan_body_shape"
    CHECK (jsonb_typeof("body") = 'object' AND jsonb_typeof("body" -> 'days') = 'array');

-- ── MemberWorkoutDraft — the generation job, at most one per member ──────────────

CREATE TABLE "MemberWorkoutDraft" (
    "memberId"   UUID                 NOT NULL,
    "jobId"      UUID                 NOT NULL,
    "status"     "WorkoutDraftStatus" NOT NULL,
    "intake"     JSONB                NOT NULL,
    "plan"       JSONB                NOT NULL,
    "error"      TEXT,
    "model"      TEXT,
    "consentAt"  TIMESTAMPTZ(3)       NOT NULL,
    "startedAt"  TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstDayAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "updatedAt"  TIMESTAMPTZ(3)       NOT NULL,

    CONSTRAINT "MemberWorkoutDraft_pkey" PRIMARY KEY ("memberId")
);

ALTER TABLE "MemberWorkoutDraft" ADD CONSTRAINT "MemberWorkoutDraft_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Both JSON columns are objects: the intake summary, and the (possibly partial) plan
-- the job fills in line by line.
ALTER TABLE "MemberWorkoutDraft" ADD CONSTRAINT "MemberWorkoutDraft_json_shape"
    CHECK (jsonb_typeof("intake") = 'object' AND jsonb_typeof("plan") = 'object');

-- ── WorkoutAiQuota — AI actions spent per member per gym day ─────────────────────

CREATE TABLE "WorkoutAiQuota" (
    "memberId" UUID     NOT NULL,
    "day"      DATE     NOT NULL,
    "used"     SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "WorkoutAiQuota_pkey" PRIMARY KEY ("memberId", "day")
);

ALTER TABLE "WorkoutAiQuota" ADD CONSTRAINT "WorkoutAiQuota_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A refund can never take the ledger below zero.
ALTER TABLE "WorkoutAiQuota" ADD CONSTRAINT "WorkoutAiQuota_used_nonnegative"
    CHECK ("used" >= 0);

-- ── ExerciseGuide — the shared How-to cache, nothing personal in it ──────────────

CREATE TABLE "ExerciseGuide" (
    "slug"      TEXT           NOT NULL,
    "name"      TEXT           NOT NULL,
    "body"      JSONB          NOT NULL,
    "model"     TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExerciseGuide_pkey" PRIMARY KEY ("slug")
);

-- The key is `exerciseSlug(name)` from @got/shared, and nothing else can be one.
ALTER TABLE "ExerciseGuide" ADD CONSTRAINT "ExerciseGuide_slug_shape"
    CHECK ("slug" ~ '^[a-z0-9-]{1,80}$');

-- steps is a list; the three strings are validated by the API on write and read.
ALTER TABLE "ExerciseGuide" ADD CONSTRAINT "ExerciseGuide_body_shape"
    CHECK (jsonb_typeof("body") = 'object' AND jsonb_typeof("body" -> 'steps') = 'array');

-- ── Lock them like every other table ──────────────────────────────────────────────
-- Supabase's default grants give `anon` (the key in the browser bundle) and
-- `authenticated` full DML across public. A member's plan, health flag and AI ledger
-- must not be readable through the REST API; the browser's only door is NestJS.
-- ENABLE (not FORCE) leaves the server, which connects as a BYPASSRLS role, unaffected.
ALTER TABLE "MemberWorkoutPlan"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MemberWorkoutDraft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutAiQuota"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExerciseGuide"      ENABLE ROW LEVEL SECURITY;

-- Guarded: `anon` and `authenticated` are Supabase's roles and do not exist in the
-- plain Postgres the e2e harness builds from these same migrations.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "MemberWorkoutPlan", "MemberWorkoutDraft", "WorkoutAiQuota", "ExerciseGuide" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "MemberWorkoutPlan", "MemberWorkoutDraft", "WorkoutAiQuota", "ExerciseGuide" FROM authenticated';
  END IF;
END
$rls$;
