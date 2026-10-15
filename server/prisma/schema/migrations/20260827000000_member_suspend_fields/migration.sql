-- C1: member write routes. Hand-authored — NOT applied by this session (see
-- task-C1-report.md): `prisma migrate dev --create-only` refused with a
-- pre-existing, unrelated checksum drift on
-- 20260820010000_chunk2_station_attendance, which only `prisma migrate
-- reset` (drops the whole dev database) would clear, and that was never run.
-- This file was written by hand to match what `--create-only` would have
-- generated from the schema.prisma edit already on this branch. Apply with
-- `prisma migrate dev` once the drift above is resolved.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "emergencyContact" TEXT;
ALTER TABLE "User" ADD COLUMN "suspendedAt" TIMESTAMPTZ(3);
ALTER TABLE "User" ADD COLUMN "suspendedById" UUID;
ALTER TABLE "User" ADD COLUMN "suspendReason" TEXT;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_suspendedById_fkey" FOREIGN KEY ("suspendedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written CHECK constraints (CHECKs live only in migration SQL in this
-- repo). Mirrors Payment_void_shape's voidedAt/voidedById/voidReason trio
-- exactly (payment.prisma / 20260819083833_add_membership_billing), split
-- into three CHECKs instead of one OR-shape for readability — semantically
-- equivalent. Deliberately left UNMAPPED in prisma-error.mapper.ts: suspend()
-- / reactivate() write all three-or-none fields in one atomic update, so no
-- client input can trigger these — a violation would be a service bug, same
-- reasoning as CoachAssignment_end_shape there.
--
-- Added NOT VALID, then VALIDATEd in a separate statement. The three columns
-- above are brand new and therefore NULL on every existing row, so
-- User_suspend_actor_shape and User_suspend_reason_shape hold trivially — but
-- User_suspend_shape reads "status", which is NOT new: any row already sitting
-- at SUSPENDED (hand-set in psql, or written by an older build) would fail the
-- constraint the instant it was added and abort this migration halfway,
-- leaving the columns added and the constraints missing with no way to re-run.
-- NOT VALID skips the backfill scan entirely and still enforces the CHECK on
-- every subsequent INSERT/UPDATE; VALIDATE CONSTRAINT then does the scan under
-- a weaker lock, and its failure — if there IS such a row — is a clean,
-- diagnosable stop with the columns already in place.
ALTER TABLE "User"
  ADD CONSTRAINT "User_suspend_shape" CHECK (
    ("status" = 'SUSPENDED') = ("suspendedAt" IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT "User_suspend_actor_shape" CHECK (
    ("suspendedAt" IS NOT NULL) = ("suspendedById" IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT "User_suspend_reason_shape" CHECK (
    ("suspendedAt" IS NOT NULL) = ("suspendReason" IS NOT NULL)
  ) NOT VALID;

-- Backfill any pre-existing SUSPENDED row into the shape the CHECK requires,
-- so VALIDATE below has nothing to trip on. There is no honest actor or reason
-- to attribute such a row to, and inventing one would poison the audit trail —
-- so the row is moved back to ACTIVE instead, which is the state it was in
-- before someone set the column by hand. Zero rows on a clean database.
UPDATE "User"
  SET "status" = 'ACTIVE'
  WHERE "status" = 'SUSPENDED' AND "suspendedAt" IS NULL;

ALTER TABLE "User"
  VALIDATE CONSTRAINT "User_suspend_shape";
ALTER TABLE "User"
  VALIDATE CONSTRAINT "User_suspend_actor_shape";
ALTER TABLE "User"
  VALIDATE CONSTRAINT "User_suspend_reason_shape";
