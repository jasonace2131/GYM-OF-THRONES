-- Hand-written for the same reason every migration since
-- 20260827010000_payment_void_kind has been: `prisma migrate dev` still
-- refuses against the shared dev database over checksum drift on
-- 20260820010000_chunk2_station_attendance and offers only a reset.
--
-- `audit.read` has been a seeded permission with no table behind it since the
-- RBAC work shipped, and the specs have carried an "AuditLog is absent" caveat
-- for the whole of that time. This is that table.
--
-- FORWARD-ONLY (owner decision). Nothing is back-filled, so a gap before this
-- migration's date means "not recorded" and never "did not happen" — which the
-- screen states rather than presenting an empty list as an innocent history.

CREATE TYPE "AuditAction" AS ENUM (
  'PAYMENT_VOIDED',
  'CHECKIN_OVERRIDDEN',
  'CHECKIN_VOIDED',
  'MEMBER_SUSPENDED',
  'MEMBER_REACTIVATED',
  'MEMBER_DELETED',
  'MEMBER_RESTORED',
  'ROLE_CHANGED',
  'PLAN_UPDATED',
  'PLAN_ARCHIVED',
  'OPENING_HOURS_CHANGED'
);

CREATE TABLE "AuditLog" (
  "id"           UUID          NOT NULL,
  "action"       "AuditAction" NOT NULL,
  "actorId"      UUID          NOT NULL,
  -- The actor's role AT THE TIME. Snapshotted rather than read through the
  -- relation, so a later promotion cannot rewrite what somebody was when they
  -- did it — the most common way an audit trail quietly starts lying.
  "actorRole"    "Role"        NOT NULL,
  "subjectType"  TEXT          NOT NULL,
  "subjectId"    UUID,
  -- How the subject read at the time. Denormalised so a deleted or renamed
  -- row still produces a legible line.
  "subjectLabel" TEXT,
  "reason"       TEXT,
  "details"      JSONB,
  "originIpHash" CHAR(64),
  "occurredAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- RESTRICT, deliberately, and unlike every other actor reference in this
-- schema: an account named by an audit entry cannot be deleted out from under
-- it. That single clause is what makes "append-only" a property of the
-- database rather than a promise in a comment. Members are soft-deleted, so it
-- costs nothing in normal operation.
ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A blank subject type makes a row that cannot be filtered or read. Every
-- producer names the table it acted on.
ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_subject_type_present"
  CHECK (length(btrim("subjectType")) > 0);

-- A reason that is present must say something. NULL is the honest value for
-- the actions whose DTO never asked for one; a one-character reason is not.
ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_reason_sane"
  CHECK ("reason" IS NULL OR length(btrim("reason")) >= 3);

-- Never a raw address. Same rule and same width as CheckIn.originIpHash and
-- Lead.originIpHash, which use the same pepper.
ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_origin_hash_shape"
  CHECK ("originIpHash" IS NULL OR "originIpHash" ~ '^[0-9a-f]{64}$');

-- The screen's default: newest first.
CREATE INDEX "AuditLog_occurredAt_idx" ON "AuditLog" ("occurredAt" DESC);

-- "What has this operator been doing?"
CREATE INDEX "AuditLog_actorId_occurredAt_idx" ON "AuditLog" ("actorId", "occurredAt" DESC);

-- "Show me every void."
CREATE INDEX "AuditLog_action_occurredAt_idx" ON "AuditLog" ("action", "occurredAt" DESC);

-- "Everything that ever happened to this member."
CREATE INDEX "AuditLog_subjectType_subjectId_idx" ON "AuditLog" ("subjectType", "subjectId");
