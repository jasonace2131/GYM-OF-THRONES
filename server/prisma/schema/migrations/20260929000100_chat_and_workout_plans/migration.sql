-- Coach tools (feat/coach-tools): coach <-> member chat, and one workout plan per member.
--
-- Hand-written: prisma migrate dev refuses on the shared dev DB (checksum drift).
-- ADDITIVE ONLY: four new tables, nothing existing is altered, so main's code keeps
-- running against this schema during the deploy window.
--
-- The chat socket is Supabase Realtime Broadcast (the doorbell); THESE TABLES ARE THE
-- RECORD. NestJS is the only writer, and the browser never reads them directly — every
-- table below is deny-all RLS like every other application table.

-- ── Chat ──────────────────────────────────────────────────────────────────────────

-- One thread per coach-member pair, for ever. It outlives the assignment that opened
-- it: once the pair has no ACTIVE CoachAssignment the thread is read-only history.
CREATE TABLE "ChatThread" (
    "id"            UUID           NOT NULL,
    "coachId"       UUID           NOT NULL,
    "memberId"      UUID           NOT NULL,
    "createdAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMPTZ(3),

    CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatMessage" (
    "id"        UUID           NOT NULL,
    "threadId"  UUID           NOT NULL,
    "senderId"  UUID           NOT NULL,
    "body"      TEXT           NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt"  TIMESTAMPTZ(3),
    -- Soft delete. The body is KEPT: a withdrawn message is exactly what a complaint
    -- review (chat.review) may need to see. Participants are shown a tombstone.
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- Drives the unread badges: everything the other party sent after this instant.
CREATE TABLE "ChatReadState" (
    "threadId"   UUID           NOT NULL,
    "userId"     UUID           NOT NULL,
    "lastReadAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChatReadState_pkey" PRIMARY KEY ("threadId", "userId")
);

CREATE UNIQUE INDEX "ChatThread_coachId_memberId_key" ON "ChatThread" ("coachId", "memberId");
CREATE INDEX "ChatThread_memberId_idx" ON "ChatThread" ("memberId");
-- The page query and both cursors read (threadId, createdAt).
CREATE INDEX "ChatMessage_threadId_createdAt_idx" ON "ChatMessage" ("threadId", "createdAt");
CREATE INDEX "ChatReadState_userId_idx" ON "ChatReadState" ("userId");

-- RESTRICT everywhere: accounts are soft-deleted, and a conversation is a record a
-- complaint may turn on — it must not disappear because a row it names did.
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_coachId_fkey"
    FOREIGN KEY ("coachId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_senderId_fkey"
    FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatReadState" ADD CONSTRAINT "ChatReadState_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatReadState" ADD CONSTRAINT "ChatReadState_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A coach does not coach themselves (CoachAssignment already refuses it).
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_distinct_parties"
    CHECK ("coachId" <> "memberId");

-- 1-2000 characters, and never only whitespace. The API trims and checks the same
-- bounds; this is what makes them true of every row rather than of every route.
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_body_length"
    CHECK (char_length(btrim("body")) >= 1 AND char_length("body") <= 2000);

-- ── Workout plans ─────────────────────────────────────────────────────────────────

-- The member's CURRENT plan: one row per member (memberId is unique). A new save
-- replaces the body; WORKOUT_PLAN_SAVED in the audit log is the history of who saved.
CREATE TABLE "WorkoutPlan" (
    "id"          UUID           NOT NULL,
    "memberId"    UUID           NOT NULL,
    "coachId"     UUID           NOT NULL,
    "body"        JSONB          NOT NULL,
    "createdAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMPTZ(3) NOT NULL,
    "updatedById" UUID           NOT NULL,

    CONSTRAINT "WorkoutPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkoutPlan_memberId_key" ON "WorkoutPlan" ("memberId");
CREATE INDEX "WorkoutPlan_coachId_idx" ON "WorkoutPlan" ("coachId");

ALTER TABLE "WorkoutPlan" ADD CONSTRAINT "WorkoutPlan_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkoutPlan" ADD CONSTRAINT "WorkoutPlan_coachId_fkey"
    FOREIGN KEY ("coachId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkoutPlan" ADD CONSTRAINT "WorkoutPlan_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The plan is written FOR a member, never by them: the member reads it only.
ALTER TABLE "WorkoutPlan" ADD CONSTRAINT "WorkoutPlan_author_not_member"
    CHECK ("coachId" <> "memberId" AND "updatedById" <> "memberId");

-- The full schema ({ summary, days: [{ day, focus, exercises: [...] }] }) is validated
-- by the API, on the model's reply and on every save. This is the floor under it: a
-- body that is not an object with a days array is never a plan.
ALTER TABLE "WorkoutPlan" ADD CONSTRAINT "WorkoutPlan_body_shape"
    CHECK (jsonb_typeof("body") = 'object' AND jsonb_typeof("body" -> 'days') = 'array');

-- ── Lock them like every other table ──────────────────────────────────────────────
-- Supabase's default grants give `anon` (the key in the browser bundle) and
-- `authenticated` full DML across public. A chat log must not be readable through the
-- REST API; the browser's only door to it is NestJS.
ALTER TABLE "ChatThread"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChatMessage"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChatReadState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutPlan"   ENABLE ROW LEVEL SECURITY;

-- Guarded: `anon` and `authenticated` are Supabase's roles and do not exist in the
-- plain Postgres the e2e harness builds from these same migrations.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "ChatThread", "ChatMessage", "ChatReadState", "WorkoutPlan" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "ChatThread", "ChatMessage", "ChatReadState", "WorkoutPlan" FROM authenticated';
  END IF;
END
$rls$;
