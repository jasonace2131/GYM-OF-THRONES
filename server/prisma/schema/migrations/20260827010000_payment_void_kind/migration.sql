-- C3: refund vs void distinction. Hand-authored — NOT applied by this session,
-- same reason as 20260827000000_member_suspend_fields: the shared dev DB has
-- pre-existing checksum drift on 20260820010000_chunk2_station_attendance,
-- which makes `prisma migrate dev` (including --create-only) refuse and offer
-- only `prisma migrate reset` (drops the whole shared database) as a fix.
-- Neither was run. This file was written by hand to match what --create-only
-- would have generated from the payment.prisma edit already on this branch.
-- Apply with `prisma migrate dev` once the drift above is resolved.

-- CreateEnum
CREATE TYPE "PaymentVoidKind" AS ENUM ('VOID', 'REFUND');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "voidKind" "PaymentVoidKind";

-- Backfill: every row voided before this column existed was a plain void —
-- REFUND did not exist as a concept yet, so there is no ambiguity to guess at.
UPDATE "Payment" SET "voidKind" = 'VOID' WHERE "voidedAt" IS NOT NULL AND "voidKind" IS NULL;

-- Hand-written CHECK constraint (CHECKs live only in migration SQL in this
-- repo). Same shape as Payment_void_shape's voidedAt/voidedById pairing
-- (20260819083833_add_membership_billing) and User_suspend_actor_shape
-- (20260827000000_member_suspend_fields): voidKind is NOT NULL exactly when
-- voidedAt is. Run AFTER the backfill above, or every pre-existing voided row
-- would violate it the instant it's added.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_void_kind_shape" CHECK (
    ("voidedAt" IS NULL) = ("voidKind" IS NULL)
  );
