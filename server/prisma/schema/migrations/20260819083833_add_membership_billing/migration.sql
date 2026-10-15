-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'FROZEN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MembershipEventType" AS ENUM ('IMPORTED', 'PURCHASED', 'RENEWED', 'REACTIVATED', 'EXPIRED', 'HOLD_APPLIED', 'HOLD_RELEASED', 'CANCELLATION_REQUESTED', 'CANCELLATION_WITHDRAWN', 'CANCELLED', 'ADJUSTED', 'STATUS_CORRECTED');

-- CreateEnum
CREATE TYPE "HoldStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlanKind" AS ENUM ('TERM', 'WALK_IN');

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('MEMBERSHIP', 'WALK_IN', 'FREEZE_FEE');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'GCASH');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('RECORDED', 'VOIDED');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('NONE', 'SENIOR', 'PWD', 'PROMO', 'STAFF', 'GUEST_PASS', 'GOODWILL');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "AccessVerdict" AS ENUM ('ALLOWED', 'ALLOWED_IN_GRACE');

-- CreateEnum
CREATE TYPE "DenialReason" AS ENUM ('NO_MEMBERSHIP', 'MEMBERSHIP_EXPIRED', 'MEMBERSHIP_FROZEN', 'MEMBERSHIP_CANCELLED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_DEACTIVATED', 'STATION_TOKEN_EXPIRED', 'ALREADY_CHECKED_IN', 'CHECKIN_DAILY_LIMIT', 'GYM_CLOSED');

-- AlterTable
-- §5.8.1: hand-edited. A bare `SET DATA TYPE TIMESTAMPTZ(3)` interprets the
-- naked value using the SESSION's TimeZone. Prisma writes UTC into these
-- columns, so the cast is only correct if the migrating session is in UTC —
-- forcing it explicitly here is what makes that true regardless of the
-- developer machine's local TimeZone setting.
ALTER TABLE "User" ADD COLUMN     "seniorPwdIdNo" TEXT;

SET TIME ZONE 'UTC';

ALTER TABLE "User"
  ALTER COLUMN "createdAt"  TYPE TIMESTAMPTZ(3) USING "createdAt"  AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt"  TYPE TIMESTAMPTZ(3) USING "updatedAt"  AT TIME ZONE 'UTC',
  ALTER COLUMN "lastSeenAt" TYPE TIMESTAMPTZ(3) USING "lastSeenAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "deletedAt"  TYPE TIMESTAMPTZ(3) USING "deletedAt"  AT TIME ZONE 'UTC';

-- CreateTable
CREATE TABLE "MembershipEvent" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "type" "MembershipEventType" NOT NULL,
    "fromStatus" "MembershipStatus",
    "toStatus" "MembershipStatus" NOT NULL,
    "previousEndsOn" DATE,
    "newEndsOn" DATE,
    "reason" TEXT,
    "actorId" UUID,
    "paymentId" UUID,
    "batchRef" TEXT,
    "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipHold" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "status" "HoldStatus" NOT NULL DEFAULT 'SCHEDULED',
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "daysRequested" INTEGER NOT NULL,
    "daysApplied" INTEGER NOT NULL DEFAULT 0,
    "activeMembershipId" UUID,
    "reason" TEXT NOT NULL,
    "feeWaived" BOOLEAN NOT NULL DEFAULT false,
    "approvedById" UUID NOT NULL,
    "releasedAt" TIMESTAMPTZ(3),
    "releasedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MembershipHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "planCode" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "planPriceCentavos" INTEGER NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "graceDays" INTEGER NOT NULL,
    "guestPassesPerTerm" INTEGER NOT NULL DEFAULT 0,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "billingAnchorDay" INTEGER NOT NULL,
    "joinedOn" DATE NOT NULL,
    "cancelRequestedOn" DATE,
    "cancelledOn" DATE,
    "graceAdmissionsThisTerm" INTEGER NOT NULL DEFAULT 0,
    "freezesUsedThisTerm" INTEGER NOT NULL DEFAULT 0,
    "guestPassesRemaining" INTEGER NOT NULL DEFAULT 0,
    "purchasedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "membershipId" UUID,
    "planId" UUID NOT NULL,
    "purpose" "PaymentPurpose" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'RECORDED',
    "planCode" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "grossCentavos" INTEGER NOT NULL,
    "vatBaseCentavos" INTEGER NOT NULL,
    "discountType" "DiscountType" NOT NULL DEFAULT 'NONE',
    "discountCentavos" INTEGER NOT NULL DEFAULT 0,
    "netCentavos" INTEGER NOT NULL,
    "vatExempt" BOOLEAN NOT NULL DEFAULT false,
    "statutoryIdNo" TEXT,
    "discountReason" TEXT,
    "termMonths" INTEGER,
    "termStartsOn" DATE,
    "termEndsOn" DATE,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "receiptNo" TEXT,
    "receiptIssued" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "businessDate" DATE NOT NULL,
    "shiftId" UUID NOT NULL,
    "recordedById" UUID NOT NULL,
    "notes" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "idempotencyHash" CHAR(64) NOT NULL,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "PlanKind" NOT NULL,
    "priceCentavos" INTEGER NOT NULL,
    "termMonths" INTEGER,
    "freezable" BOOLEAN NOT NULL DEFAULT false,
    "guestPassesPerTerm" INTEGER NOT NULL DEFAULT 0,
    "graceDays" INTEGER NOT NULL DEFAULT 3,
    "perks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" UUID NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" UUID NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "openingFloatCentavos" INTEGER NOT NULL,
    "closedById" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "countedCentavos" INTEGER,
    "expectedCentavos" INTEGER,
    "varianceCentavos" INTEGER,
    "note" TEXT,
    "businessDate" DATE NOT NULL,
    "openMarker" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MembershipEvent_membershipId_effectiveAt_idx" ON "MembershipEvent"("membershipId", "effectiveAt" DESC);

-- CreateIndex
CREATE INDEX "MembershipEvent_type_effectiveAt_idx" ON "MembershipEvent"("type", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipEvent_membershipId_batchRef_key" ON "MembershipEvent"("membershipId", "batchRef");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipHold_activeMembershipId_key" ON "MembershipHold"("activeMembershipId");

-- CreateIndex
CREATE INDEX "MembershipHold_membershipId_startsOn_idx" ON "MembershipHold"("membershipId", "startsOn" DESC);

-- CreateIndex
CREATE INDEX "MembershipHold_status_startsOn_idx" ON "MembershipHold"("status", "startsOn");

-- CreateIndex
CREATE INDEX "MembershipHold_status_endsOn_idx" ON "MembershipHold"("status", "endsOn");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_key" ON "Membership"("userId");

-- CreateIndex
CREATE INDEX "Membership_status_endsOn_idx" ON "Membership"("status", "endsOn");

-- CreateIndex
CREATE INDEX "Membership_endsOn_idx" ON "Membership"("endsOn");

-- CreateIndex
CREATE INDEX "Membership_planId_idx" ON "Membership"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payment_userId_receivedAt_idx" ON "Payment"("userId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "Payment_shiftId_status_idx" ON "Payment"("shiftId", "status");

-- CreateIndex
CREATE INDEX "Payment_businessDate_status_idx" ON "Payment"("businessDate", "status");

-- CreateIndex
CREATE INDEX "Payment_membershipId_termStartsOn_idx" ON "Payment"("membershipId", "termStartsOn");

-- CreateIndex
CREATE INDEX "Payment_discountType_businessDate_idx" ON "Payment"("discountType", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- CreateIndex
CREATE INDEX "Plan_isActive_sortOrder_idx" ON "Plan"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_openMarker_key" ON "Shift"("openMarker");

-- CreateIndex
CREATE INDEX "Shift_businessDate_idx" ON "Shift"("businessDate");

-- CreateIndex
CREATE INDEX "Shift_status_openedAt_idx" ON "Shift"("status", "openedAt");

-- AddForeignKey
ALTER TABLE "MembershipEvent" ADD CONSTRAINT "MembershipEvent_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipEvent" ADD CONSTRAINT "MembershipEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipEvent" ADD CONSTRAINT "MembershipEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipHold" ADD CONSTRAINT "MembershipHold_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipHold" ADD CONSTRAINT "MembershipHold_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipHold" ADD CONSTRAINT "MembershipHold_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- §5.8.2 – §5.8.6 — Hand-written CHECK / EXCLUDE constraints and the
-- MembershipEvent append-only trigger. None of this is visible to Prisma:
-- it is never introspected, never reported as drift, never dropped.
-- ============================================================================

-- §5.8.2 Plan
ALTER TABLE "Plan"
  ADD CONSTRAINT "Plan_price_bounded"   CHECK ("priceCentavos" BETWEEN 0 AND 10000000),
  ADD CONSTRAINT "Plan_grace_bounded"   CHECK ("graceDays" BETWEEN 0 AND 14),
  ADD CONSTRAINT "Plan_passes_bounded"  CHECK ("guestPassesPerTerm" BETWEEN 0 AND 12),
  ADD CONSTRAINT "Plan_term_matches_kind" CHECK (
    ("kind" = 'TERM'    AND "termMonths" IS NOT NULL AND "termMonths" BETWEEN 1 AND 60) OR
    ("kind" = 'WALK_IN' AND "termMonths" IS NULL AND "freezable" = false)
  );

-- §5.8.3 Membership and MembershipHold
ALTER TABLE "Membership"
  ADD CONSTRAINT "Membership_dates_ordered"  CHECK ("endsOn" >= "startsOn"),
  ADD CONSTRAINT "Membership_anchor_valid"   CHECK ("billingAnchorDay" BETWEEN 1 AND 31),
  ADD CONSTRAINT "Membership_term_bounded"   CHECK ("termMonths" BETWEEN 1 AND 60),
  ADD CONSTRAINT "Membership_grace_bounded"  CHECK ("graceDays" BETWEEN 0 AND 14),
  ADD CONSTRAINT "Membership_price_nonneg"   CHECK ("planPriceCentavos" >= 0),
  ADD CONSTRAINT "Membership_counters_sane"  CHECK (
    "graceAdmissionsThisTerm" >= 0 AND "freezesUsedThisTerm" >= 0
    AND "guestPassesRemaining" BETWEEN 0 AND "guestPassesPerTerm"
  ),
  ADD CONSTRAINT "Membership_cancel_shape"   CHECK (
    ("status" = 'CANCELLED') = ("cancelledOn" IS NOT NULL)
  );

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "MembershipHold"
  ADD CONSTRAINT "MembershipHold_dates_ordered" CHECK ("endsOn" >= "startsOn"),
  ADD CONSTRAINT "MembershipHold_days_bounded"
    CHECK ("daysRequested" BETWEEN 7 AND 90
       AND "daysApplied" BETWEEN 0 AND "daysRequested"),
  -- The sentinel points at the right membership …
  ADD CONSTRAINT "MembershipHold_active_marker"
    CHECK ("activeMembershipId" IS NULL OR "activeMembershipId" = "membershipId"),
  -- … and cannot be forgotten. Without this, an UPDATE that omits the sentinel
  -- creates a second running hold invisible to the unique index, and two
  -- writers race on endsOn.
  ADD CONSTRAINT "MembershipHold_active_marker_agrees"
    CHECK (("status" = 'ACTIVE') = ("activeMembershipId" IS NOT NULL)),
  ADD CONSTRAINT "MembershipHold_release_shape"
    CHECK (("status" IN ('COMPLETED','CANCELLED')) = ("releasedAt" IS NOT NULL)),
  -- Overlapping holds would double-extend endsOn with no way to reconstruct
  -- the arithmetic afterwards. Cancelled holds are excluded so a cancellation
  -- frees the window; the one-freeze-per-term counter is what stops that being
  -- a loop.
  ADD CONSTRAINT "MembershipHold_no_overlap"
    EXCLUDE USING gist (
      "membershipId" WITH =,
      daterange("startsOn", "endsOn", '[]') WITH &&
    ) WHERE ("status" IN ('SCHEDULED', 'ACTIVE'));

-- §5.8.4 MembershipEvent append-only trigger
CREATE OR REPLACE FUNCTION "membership_event_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MembershipEvent is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "MembershipEvent_append_only"
  BEFORE UPDATE OR DELETE ON "MembershipEvent"
  FOR EACH ROW EXECUTE FUNCTION "membership_event_append_only"();

ALTER TABLE "MembershipEvent"
  ADD CONSTRAINT "MembershipEvent_reason_required" CHECK (
    "type" NOT IN ('ADJUSTED','STATUS_CORRECTED','CANCELLED')
    OR ("reason" IS NOT NULL AND length(btrim("reason")) >= 3)
  ),
  ADD CONSTRAINT "MembershipEvent_dates_paired" CHECK (
    ("previousEndsOn" IS NULL) = ("newEndsOn" IS NULL)
  );

-- §5.8.5 Payment and Shift
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_gross_positive" CHECK ("grossCentavos" BETWEEN 1 AND 10000000),
  ADD CONSTRAINT "Payment_money_consistent" CHECK (
    "vatBaseCentavos" BETWEEN 0 AND "grossCentavos"
    AND "discountCentavos" BETWEEN 0 AND "vatBaseCentavos"
    AND "netCentavos" = "vatBaseCentavos" - "discountCentavos"
    AND ("vatExempt" OR "vatBaseCentavos" = "grossCentavos")
  ),
  -- A ₱0 collection is legal only when it is a comp. This is what makes guest
  -- passes, the free PT session and comped staff memberships representable.
  ADD CONSTRAINT "Payment_zero_only_when_comped" CHECK (
    "netCentavos" > 0 OR "discountType" IN ('PROMO','STAFF','GUEST_PASS','GOODWILL')
  ),
  ADD CONSTRAINT "Payment_discount_shape" CHECK (
    ("discountType" = 'NONE' AND "discountCentavos" = 0)
    OR ("discountType" IN ('SENIOR','PWD')
        AND "statutoryIdNo" IS NOT NULL AND length(btrim("statutoryIdNo")) > 0)
    OR ("discountType" IN ('PROMO','STAFF','GUEST_PASS','GOODWILL')
        AND "discountReason" IS NOT NULL AND length(btrim("discountReason")) >= 3)
  ),
  ADD CONSTRAINT "Payment_purpose_shape" CHECK (
    ("purpose" = 'MEMBERSHIP' AND "membershipId" IS NOT NULL AND "userId" IS NOT NULL
                              AND "termMonths" BETWEEN 1 AND 60
                              AND "termStartsOn" IS NOT NULL AND "termEndsOn" IS NOT NULL
                              AND "termEndsOn" >= "termStartsOn") OR
    ("purpose" = 'FREEZE_FEE' AND "membershipId" IS NOT NULL AND "userId" IS NOT NULL
                              AND "termMonths" IS NULL
                              AND "termStartsOn" IS NULL AND "termEndsOn" IS NULL) OR
    ("purpose" = 'WALK_IN'    AND "membershipId" IS NULL
                              AND "termMonths" IS NULL
                              AND "termStartsOn" IS NULL AND "termEndsOn" IS NULL)
  ),
  ADD CONSTRAINT "Payment_gcash_reference" CHECK (
    "method" <> 'GCASH' OR ("reference" IS NOT NULL AND length(btrim("reference")) > 0)
  ),
  ADD CONSTRAINT "Payment_void_shape" CHECK (
    ("status" = 'RECORDED' AND "voidedAt" IS NULL     AND "voidedById" IS NULL) OR
    ("status" = 'VOIDED'   AND "voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL
                           AND "voidReason" IS NOT NULL)
  );

ALTER TABLE "Shift"
  ADD CONSTRAINT "Shift_float_nonneg" CHECK ("openingFloatCentavos" >= 0),
  ADD CONSTRAINT "Shift_open_marker" CHECK (
    ("status" = 'OPEN') = ("openMarker" IS NOT NULL)
  ),
  ADD CONSTRAINT "Shift_close_shape" CHECK (
    ("status" = 'OPEN'   AND "closedAt" IS NULL AND "countedCentavos" IS NULL) OR
    ("status" = 'CLOSED' AND "closedAt" IS NOT NULL AND "closedById" IS NOT NULL
                         AND "countedCentavos" IS NOT NULL
                         AND "expectedCentavos" IS NOT NULL
                         AND "varianceCentavos" = "countedCentavos" - "expectedCentavos")
  );
