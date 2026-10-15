-- Workout sessions (feat/workout-sessions): a member's workout, started from one day
-- of their own plan or of their coach's plan, and the sets they ticked in it.
-- Spec: docs/superpowers/specs/2026-09-29-workout-sessions-design.md §2.
--
-- Hand-written: prisma migrate dev refuses on the shared dev DB (checksum drift).
-- ADDITIVE ONLY: two new enums and two new tables. No existing enum or table is
-- altered, so main's code keeps running against this schema during the deploy window.
--
-- Every CHECK and the partial unique index below live ONLY here — Prisma cannot
-- represent them — so test/workout-sessions-constraints.e2e-spec.ts asserts each
-- name AND predicate. A `db push` or a regenerated migration would drop them
-- silently while every service test kept passing.

-- ── Enums ─────────────────────────────────────────────────────────────────────────

CREATE TYPE "WorkoutSessionSource" AS ENUM ('MEMBER_PLAN', 'COACH_PLAN');
CREATE TYPE "WorkoutFeeling"       AS ENUM ('EASY', 'RIGHT', 'HARD');

-- ── WorkoutSession — one workout, its day snapshotted, one open per member ──────

CREATE TABLE "WorkoutSession" (
    "id"             UUID                   NOT NULL,
    "memberId"       UUID                   NOT NULL,
    "source"         "WorkoutSessionSource" NOT NULL,
    "memberPlanId"   UUID,
    "coachPlanId"    UUID,
    "planName"       TEXT                   NOT NULL,
    "coachFirstName" TEXT,
    "coachLastName"  TEXT,
    "dayTitle"       TEXT                   NOT NULL,
    "weekday"        SMALLINT,
    "exercises"      JSONB                  NOT NULL,
    "businessDate"   DATE                   NOT NULL,
    "startedAt"      TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt"     TIMESTAMPTZ(3),
    "feeling"        "WorkoutFeeling",
    "createdAt"      TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMPTZ(3)         NOT NULL,

    CONSTRAINT "WorkoutSession_pkey" PRIMARY KEY ("id")
);

-- History: a member's workouts, newest first.
CREATE INDEX "WorkoutSession_memberId_startedAt_idx" ON "WorkoutSession" ("memberId", "startedAt" DESC);

-- ONE OPEN WORKOUT PER MEMBER, as a database fact. Partial, so finished sessions do
-- not collide. The API inserts with ON CONFLICT DO NOTHING and answers 409
-- WORKOUT_SESSION_OPEN when nothing was inserted — never a caught violation inside
-- a transaction. Prisma has no representation for a partial index and will offer to
-- drop it on every `migrate diff` — the same known drift as MemberWorkoutPlan_one_active.
CREATE UNIQUE INDEX "WorkoutSession_one_open" ON "WorkoutSession" ("memberId") WHERE "finishedAt" IS NULL;

ALTER TABLE "WorkoutSession" ADD CONSTRAINT "WorkoutSession_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL, both: deleting a plan keeps every workout done from it. The session
-- carries its own snapshot of the day, so nothing it shows depends on the plan.
ALTER TABLE "WorkoutSession" ADD CONSTRAINT "WorkoutSession_memberPlanId_fkey"
    FOREIGN KEY ("memberPlanId") REFERENCES "MemberWorkoutPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkoutSession" ADD CONSTRAINT "WorkoutSession_coachPlanId_fkey"
    FOREIGN KEY ("coachPlanId") REFERENCES "WorkoutPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A session came from one plan, never two.
ALTER TABLE "WorkoutSession" ADD CONSTRAINT "WorkoutSession_one_plan"
    CHECK ("memberPlanId" IS NULL OR "coachPlanId" IS NULL);

-- The link matches the source. Either may be NULL: that is a deleted plan.
ALTER TABLE "WorkoutSession" ADD CONSTRAINT "WorkoutSession_memberPlan_source"
    CHECK ("memberPlanId" IS NULL OR "source" = 'MEMBER_PLAN');

ALTER TABLE "WorkoutSession" ADD CONSTRAINT "WorkoutSession_coachPlan_source"
    CHECK ("coachPlanId" IS NULL OR "source" = 'COACH_PLAN');

-- "How did it feel?" is asked on the Done screen, so only a finished workout has one.
ALTER TABLE "WorkoutSession" ADD CONSTRAINT "WorkoutSession_feeling_finished"
    CHECK ("feeling" IS NULL OR "finishedAt" IS NOT NULL);

-- An idle session finishes at its last set, which is never before it started.
ALTER TABLE "WorkoutSession" ADD CONSTRAINT "WorkoutSession_finished_after_start"
    CHECK ("finishedAt" IS NULL OR "finishedAt" >= "startedAt");

-- The snapshot is a list of 1-12 exercises. CASE, not AND: jsonb_array_length RAISES on
-- a non-array, and Postgres does not promise to evaluate an AND left to right.
ALTER TABLE "WorkoutSession" ADD CONSTRAINT "WorkoutSession_exercises_shape"
    CHECK (CASE WHEN jsonb_typeof("exercises") = 'array'
                THEN jsonb_array_length("exercises") BETWEEN 1 AND 12
                ELSE false END);

-- 0 (Sunday) to 6 (Saturday), like OpeningHours and the member's own plans.
ALTER TABLE "WorkoutSession" ADD CONSTRAINT "WorkoutSession_weekday_range"
    CHECK ("weekday" IS NULL OR "weekday" BETWEEN 0 AND 6);

-- A plan name is 1-60 characters (MemberWorkoutPlan_name_length), never only whitespace.
ALTER TABLE "WorkoutSession" ADD CONSTRAINT "WorkoutSession_planName_length"
    CHECK (char_length(btrim("planName")) >= 1 AND char_length("planName") <= 60);

-- A day title is 1-40 characters, never only whitespace.
ALTER TABLE "WorkoutSession" ADD CONSTRAINT "WorkoutSession_dayTitle_length"
    CHECK (char_length(btrim("dayTitle")) >= 1 AND char_length("dayTitle") <= 40);

-- ── WorkoutSetLog — a ticked set; only done sets exist ───────────────────────────

CREATE TABLE "WorkoutSetLog" (
    "sessionId"     UUID           NOT NULL,
    "exerciseIndex" SMALLINT       NOT NULL,
    "setIndex"      SMALLINT       NOT NULL,
    "memberId"      UUID           NOT NULL,
    "exerciseName"  TEXT           NOT NULL,
    "exerciseSlug"  TEXT           NOT NULL,
    "weightGrams"   INTEGER,
    "reps"          SMALLINT       NOT NULL,
    "completedAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkoutSetLog_pkey" PRIMARY KEY ("sessionId", "exerciseIndex", "setIndex")
);

-- "Last time" and "best" for one exercise across the member's whole history.
CREATE INDEX "WorkoutSetLog_memberId_exerciseSlug_completedAt_idx" ON "WorkoutSetLog" ("memberId", "exerciseSlug", "completedAt" DESC);

-- CASCADE: discarding an open workout takes its ticks with it.
ALTER TABLE "WorkoutSetLog" ADD CONSTRAINT "WorkoutSetLog_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "WorkoutSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkoutSetLog" ADD CONSTRAINT "WorkoutSetLog_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A session snapshots at most 12 exercises (SESSION_LIMITS.exercisesMax).
ALTER TABLE "WorkoutSetLog" ADD CONSTRAINT "WorkoutSetLog_exerciseIndex_range"
    CHECK ("exerciseIndex" BETWEEN 0 AND 11);

-- At most 20 sets per exercise (SESSION_LIMITS.setsPerExerciseMax).
ALTER TABLE "WorkoutSetLog" ADD CONSTRAINT "WorkoutSetLog_setIndex_range"
    CHECK ("setIndex" BETWEEN 0 AND 19);

-- The key is `exerciseSlug(name)` from @got/shared, like ExerciseGuide_slug_shape.
ALTER TABLE "WorkoutSetLog" ADD CONSTRAINT "WorkoutSetLog_exerciseSlug_shape"
    CHECK ("exerciseSlug" ~ '^[a-z0-9-]{1,80}$');

-- Grams, above 0 and at most 500 kg; NULL is bodyweight.
ALTER TABLE "WorkoutSetLog" ADD CONSTRAINT "WorkoutSetLog_weightGrams_range"
    CHECK ("weightGrams" IS NULL OR "weightGrams" BETWEEN 1 AND 500000);

ALTER TABLE "WorkoutSetLog" ADD CONSTRAINT "WorkoutSetLog_reps_range"
    CHECK ("reps" BETWEEN 1 AND 200);

-- ── Lock them like every other table ──────────────────────────────────────────────
-- Supabase's default grants give `anon` (the key in the browser bundle) and
-- `authenticated` full DML across public. A member's workout history must not be
-- readable through the REST API; the browser's only door is NestJS.
-- ENABLE (not FORCE) leaves the server, which connects as a BYPASSRLS role, unaffected.
ALTER TABLE "WorkoutSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutSetLog"  ENABLE ROW LEVEL SECURITY;

-- Guarded: `anon` and `authenticated` are Supabase's roles and do not exist in the
-- plain Postgres the e2e harness builds from these same migrations.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "WorkoutSession", "WorkoutSetLog" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "WorkoutSession", "WorkoutSetLog" FROM authenticated';
  END IF;
END
$rls$;
