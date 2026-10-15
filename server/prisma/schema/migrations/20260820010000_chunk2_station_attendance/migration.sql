-- CreateEnum
CREATE TYPE "CheckInMethod" AS ENUM ('STATION_QR', 'MEMBER_CODE', 'MANUAL');

-- CreateEnum
CREATE TYPE "CheckOutMethod" AS ENUM ('STATION_QR', 'MANUAL', 'AUTO_CLOSE', 'STALE_CLOSE');

-- CreateEnum
CREATE TYPE "CheckInEntryType" AS ENUM ('MEMBERSHIP', 'WALK_IN', 'GUEST_PASS');

-- CreateEnum
CREATE TYPE "StationScanOutcome" AS ENUM ('CHECKED_IN', 'RECHECKED_IN', 'REOPENED', 'CHECKED_OUT', 'ALREADY_INSIDE', 'DENIED');

-- CreateEnum
CREATE TYPE "DenialOutcome" AS ENUM ('UNRESOLVED', 'RESOLVED_WALK_IN', 'OVERRIDDEN', 'ABANDONED');

-- CreateTable
CREATE TABLE "CheckInDenial" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "reason" "DenialReason" NOT NULL,
    "method" "CheckInMethod" NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "businessDate" DATE NOT NULL,
    "membershipStatusAtTime" "MembershipStatus",
    "stationId" UUID,
    "stationSlot" INTEGER,
    "tokenStalenessSeconds" INTEGER,
    "originIpHash" CHAR(64),
    "offSiteOrigin" BOOLEAN NOT NULL DEFAULT false,
    "recordedById" UUID,
    "shiftId" UUID,
    "outcome" "DenialOutcome" NOT NULL DEFAULT 'UNRESOLVED',
    "resolvedByCheckInId" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "overriddenById" UUID,
    "overrideReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CheckInDenial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckIn" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "entryType" "CheckInEntryType" NOT NULL,
    "verdict" "AccessVerdict" NOT NULL,
    "membershipId" UUID,
    "membershipStatusAtTime" "MembershipStatus",
    "paymentId" UUID,
    "guestName" TEXT,
    "guestPhone" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "businessDate" DATE NOT NULL,
    "openUserId" UUID,
    "endedAt" TIMESTAMPTZ(3),
    "closeMethod" "CheckOutMethod",
    "closedById" UUID,
    "autoClosed" BOOLEAN NOT NULL DEFAULT false,
    "stationId" UUID,
    "stationSlot" INTEGER,
    "closeStationId" UUID,
    "closeStationSlot" INTEGER,
    "closeOffSiteOrigin" BOOLEAN,
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "originIpHash" CHAR(64),
    "offSiteOrigin" BOOLEAN NOT NULL DEFAULT false,
    "method" "CheckInMethod" NOT NULL,
    "recordedById" UUID,
    "shiftId" UUID,
    "photoOnFileAtTime" BOOLEAN NOT NULL DEFAULT false,
    "assignedCoachId" UUID,
    "coachNotifiedAt" TIMESTAMPTZ(3),
    "offlineQueued" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT NOT NULL,
    "idempotencyHash" CHAR(64) NOT NULL,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationCredential" (
    "id" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "keyHash" CHAR(64) NOT NULL,
    "label" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(3),
    "lastUsedIpHash" CHAR(64),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID NOT NULL,

    CONSTRAINT "StationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationScan" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "outcome" "StationScanOutcome",
    "checkInId" UUID,
    "denialId" UUID,
    "responseSnapshot" JSONB,
    "originIpHash" CHAR(64),
    "offSiteOrigin" BOOLEAN NOT NULL DEFAULT false,
    "consumedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Station" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gymCode" TEXT NOT NULL DEFAULT 'GOT',
    "tokenEpoch" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastTokenIssuedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Station_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CheckInDenial_userId_occurredAt_idx" ON "CheckInDenial"("userId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "CheckInDenial_stationId_occurredAt_idx" ON "CheckInDenial"("stationId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "CheckInDenial_businessDate_idx" ON "CheckInDenial"("businessDate");

-- CreateIndex
CREATE INDEX "CheckInDenial_outcome_idx" ON "CheckInDenial"("outcome");

-- CreateIndex
CREATE INDEX "CheckInDenial_reason_occurredAt_idx" ON "CheckInDenial"("reason", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "CheckInDenial_userId_offSiteOrigin_idx" ON "CheckInDenial"("userId", "offSiteOrigin");

-- CreateIndex
CREATE UNIQUE INDEX "CheckIn_paymentId_key" ON "CheckIn"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckIn_openUserId_key" ON "CheckIn"("openUserId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckIn_idempotencyKey_key" ON "CheckIn"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CheckIn_userId_businessDate_idx" ON "CheckIn"("userId", "businessDate");

-- CreateIndex
CREATE INDEX "CheckIn_userId_occurredAt_idx" ON "CheckIn"("userId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "CheckIn_stationId_occurredAt_idx" ON "CheckIn"("stationId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "CheckIn_businessDate_idx" ON "CheckIn"("businessDate");

-- CreateIndex
CREATE INDEX "CheckIn_assignedCoachId_idx" ON "CheckIn"("assignedCoachId");

-- CreateIndex
CREATE UNIQUE INDEX "StationCredential_keyHash_key" ON "StationCredential"("keyHash");

-- CreateIndex
CREATE INDEX "StationCredential_stationId_revokedAt_idx" ON "StationCredential"("stationId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StationScan_denialId_key" ON "StationScan"("denialId");

-- CreateIndex
CREATE INDEX "StationScan_consumedAt_idx" ON "StationScan"("consumedAt");

-- CreateIndex
CREATE INDEX "StationScan_stationId_consumedAt_idx" ON "StationScan"("stationId", "consumedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StationScan_userId_stationId_slot_key" ON "StationScan"("userId", "stationId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "Station_code_key" ON "Station"("code");

-- CreateIndex
CREATE INDEX "Station_isActive_idx" ON "Station"("isActive");

-- AddForeignKey
ALTER TABLE "CheckInDenial" ADD CONSTRAINT "CheckInDenial_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInDenial" ADD CONSTRAINT "CheckInDenial_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInDenial" ADD CONSTRAINT "CheckInDenial_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInDenial" ADD CONSTRAINT "CheckInDenial_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInDenial" ADD CONSTRAINT "CheckInDenial_resolvedByCheckInId_fkey" FOREIGN KEY ("resolvedByCheckInId") REFERENCES "CheckIn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInDenial" ADD CONSTRAINT "CheckInDenial_overriddenById_fkey" FOREIGN KEY ("overriddenById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_closeStationId_fkey" FOREIGN KEY ("closeStationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_assignedCoachId_fkey" FOREIGN KEY ("assignedCoachId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationCredential" ADD CONSTRAINT "StationCredential_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationCredential" ADD CONSTRAINT "StationCredential_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationScan" ADD CONSTRAINT "StationScan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationScan" ADD CONSTRAINT "StationScan_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationScan" ADD CONSTRAINT "StationScan_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "CheckIn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationScan" ADD CONSTRAINT "StationScan_denialId_fkey" FOREIGN KEY ("denialId") REFERENCES "CheckInDenial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- §6.3 / §6.4 — Hand-written CHECK constraints and the one partial unique
-- index Prisma cannot model. None of this is visible to Prisma: it is never
-- introspected, never reported as drift, never dropped by a stray
-- `migrate dev`.
-- ============================================================================

-- §6.3 Station. The two CHECKs below are deliberately ABSENT from
-- CONSTRAINT_ERROR_CODES: `code` is CSPRNG-allocated by the seed/admin route
-- and `tokenEpoch` only ever moves by +1 from server code, so neither can be
-- provoked by client input — a violation here is a service bug, and a 500
-- with the raw constraint in the log is the correct, loud signal for one
-- (the same reasoning CoachAssignment_end_shape already established).
ALTER TABLE "Station"
  ADD CONSTRAINT "Station_code_shape"     CHECK ("code" ~ '^[0-9A-HJKMNP-TV-Z]{4}$'),
  ADD CONSTRAINT "Station_epoch_positive" CHECK ("tokenEpoch" >= 1);

-- §6.4.1 StationScan. Slot is always server-computed from wall-clock time, so
-- this is a pure invariant, not a user-input path.
ALTER TABLE "StationScan"
  ADD CONSTRAINT "StationScan_slot_nonneg" CHECK ("slot" >= 0);

-- The replay claim (§6.4.1, §6.5.2) and the open-checkout link (§6.4.1,
-- §6.6). A plain @unique on checkInId is unimplementable: the check-out scan
-- writes the SAME checkInId as the opening scan, which would raise 23505
-- inside the interactive transaction on the ordinary check-out path. Scoped
-- uniqueness — at most one OPENING scan per visit — is a partial index
-- instead, asserted by name in the constraint-presence suite.
CREATE UNIQUE INDEX "StationScan_opening_checkin_once"
  ON "StationScan" ("checkInId")
  WHERE "outcome" IN ('CHECKED_IN', 'RECHECKED_IN', 'REOPENED');

-- §6.4.2 CheckIn.
ALTER TABLE "CheckIn"
  -- The open-visit sentinel's own pair (R3), stated for CheckIn the way
  -- CoachAssignment_active_marker / _agrees state it for activeMemberId.
  -- "The sentinel points at the right member …"
  -- Guarded with "userId" IS NOT NULL rather than a bare equality: userId is
  -- nullable (a walk-in guest has no account), and "openUserId = userId"
  -- against a NULL userId evaluates to NULL, not FALSE — which a bare
  -- `openUserId IS NULL OR openUserId = userId` would let a stray sentinel
  -- on a guest row pass silently. FALSE AND <anything> is FALSE, never NULL,
  -- so this form stays decidable in every case.
  ADD CONSTRAINT "CheckIn_open_marker" CHECK (
    "openUserId" IS NULL OR ("userId" IS NOT NULL AND "openUserId" = "userId")
  ),
  -- "… and cannot be forgotten." Without this, an UPDATE that omits the
  -- sentinel leaves a visit open (endedAt NULL) with no sentinel set, which is
  -- invisible to the unique index and lets a second visit open concurrently.
  ADD CONSTRAINT "CheckIn_open_marker_agrees" CHECK (
    ("endedAt" IS NULL) = ("openUserId" IS NOT NULL)
  ),
  -- Which columns an entryType requires. Biconditional in every branch: a
  -- one-way form would accept a WALK_IN row carrying a membershipId, which is
  -- exactly the row this constraint exists to forbid.
  ADD CONSTRAINT "CheckIn_entry_shape" CHECK (
    ("entryType" = 'MEMBERSHIP' AND "membershipId" IS NOT NULL AND "paymentId" IS NULL
                                 AND "userId" IS NOT NULL AND "membershipStatusAtTime" IS NOT NULL) OR
    ("entryType" = 'WALK_IN'    AND "paymentId" IS NOT NULL AND "membershipId" IS NULL) OR
    ("entryType" = 'GUEST_PASS' AND "paymentId" IS NULL AND "membershipId" IS NOT NULL)
  ),
  -- BICONDITIONAL, both directions. A one-way `(method = 'STATION_QR' OR
  -- recordedById IS NOT NULL)` is satisfied by a self-scan carrying a staff
  -- id, which is precisely the row this column exists to make impossible.
  ADD CONSTRAINT "CheckIn_recorder_shape" CHECK (
    ("method" = 'STATION_QR') = ("recordedById" IS NULL)
  ),
  -- Money or a staff action must always be reconcilable to a till session. A
  -- member self-scan is best-effort — see the model comment.
  ADD CONSTRAINT "CheckIn_shift_shape" CHECK (
    NOT ("entryType" = 'WALK_IN' OR "method" IN ('MEMBER_CODE', 'MANUAL'))
    OR "shiftId" IS NOT NULL
  ),
  ADD CONSTRAINT "CheckIn_station_shape" CHECK (
    ("method" = 'STATION_QR') = ("stationId" IS NOT NULL AND "stationSlot" IS NOT NULL)
  ),
  -- COALESCE guards the second clause: closeMethod is nullable (NULL on an
  -- open or never-closed row), and "closeMethod = 'STATION_QR'" against a
  -- NULL closeMethod is NULL, not FALSE — `TRUE AND NULL` is NULL, which a
  -- CHECK PASSES. A row with closeStationId set and closeMethod NULL must be
  -- rejected outright, not silently admitted.
  ADD CONSTRAINT "CheckIn_close_station_shape" CHECK (
    ("closeStationId" IS NULL) = ("closeStationSlot" IS NULL)
      AND ("closeStationId" IS NULL OR COALESCE("closeMethod" = 'STATION_QR', false))
  ),
  -- NULL-safe via COALESCE, not via an OR'd NULL guard. The spec's literal
  -- form — `(closeMethod IS NULL AND autoClosed = false) OR autoClosed =
  -- (closeMethod IN (...))` — still lets `closeMethod IS NULL, autoClosed =
  -- true` through: the first disjunct is FALSE, the second is `true = NULL`
  -- = NULL, and `FALSE OR NULL` is NULL, which a CHECK treats as PASSING
  -- (only FALSE rejects). Proven live in this commit by
  -- verify_checks.js before this fix; COALESCE(..., false) forces the
  -- NULL case to a real boolean so every branch is decidable.
  ADD CONSTRAINT "CheckIn_autoclosed_agrees" CHECK (
    "autoClosed" = COALESCE("closeMethod" IN ('AUTO_CLOSE', 'STALE_CLOSE'), false)
  ),
  ADD CONSTRAINT "CheckIn_reopen_nonneg" CHECK ("reopenCount" >= 0),
  -- Same shape as Payment_void_shape.
  ADD CONSTRAINT "CheckIn_void_shape" CHECK (
    ("voidedAt" IS NULL AND "voidedById" IS NULL) OR
    ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "voidReason" IS NOT NULL)
  );

-- §6.4.3 CheckInDenial.
ALTER TABLE "CheckInDenial"
  ADD CONSTRAINT "CheckInDenial_recorder_shape" CHECK (
    ("method" = 'STATION_QR') = ("recordedById" IS NULL)
  ),
  ADD CONSTRAINT "CheckInDenial_shift_required" CHECK (
    "method" = 'STATION_QR' OR "shiftId" IS NOT NULL
  ),
  ADD CONSTRAINT "CheckInDenial_station_shape" CHECK (
    ("method" = 'STATION_QR') = ("stationId" IS NOT NULL AND "stationSlot" IS NOT NULL)
  ),
  ADD CONSTRAINT "CheckInDenial_staleness_shape" CHECK (
    ("reason" = 'STATION_TOKEN_EXPIRED') = ("tokenStalenessSeconds" IS NOT NULL)
  ),
  ADD CONSTRAINT "CheckInDenial_staleness_nonneg" CHECK (
    "tokenStalenessSeconds" IS NULL OR "tokenStalenessSeconds" >= 0
  ),
  -- outcome and its resolution columns move together. resolvedAt is the one
  -- column common to every non-UNRESOLVED outcome.
  ADD CONSTRAINT "CheckInDenial_resolution_shape" CHECK (
    ("outcome" = 'UNRESOLVED') = ("resolvedAt" IS NULL)
  ),
  ADD CONSTRAINT "CheckInDenial_override_shape" CHECK (
    ("outcome" = 'OVERRIDDEN') = ("overriddenById" IS NOT NULL AND "overrideReason" IS NOT NULL)
  );

-- ============================================================================
-- RLS — every new table gets the same treatment as
-- 20260820000000_enable_rls_deny_all: ENABLE (not FORCE, the server connects
-- as `postgres` with BYPASSRLS) plus a guarded REVOKE, because `anon` /
-- `authenticated` are Supabase-only roles and an unguarded REVOKE fails with
-- 42704 on the bare Postgres container the e2e harness builds from.
-- ============================================================================

ALTER TABLE "Station"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StationCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StationScan"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CheckIn"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CheckInDenial"     ENABLE ROW LEVEL SECURITY;

DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "Station", "StationCredential", "StationScan", "CheckIn", "CheckInDenial" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "Station", "StationCredential", "StationScan", "CheckIn", "CheckInDenial" FROM authenticated';
  END IF;
END
$rls$;
