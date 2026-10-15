-- The amendment link. An amend voids the original and writes a corrected
-- replacement in its place — the operator's "Edit payment". The register keeps
-- both rows, because the alternative is an UPDATE that rewrites a figure a
-- member is holding a printed slip for.

ALTER TABLE "Payment" ADD COLUMN "replacesPaymentId" UUID;

-- RESTRICT, like every other Payment reference.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_replacesPaymentId_fkey"
  FOREIGN KEY ("replacesPaymentId") REFERENCES "Payment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A LINKED LIST, NOT A TREE. Without this, one voided original could be named
-- by two replacements and "which row is live" would have two answers.
CREATE UNIQUE INDEX "Payment_replacesPaymentId_key" ON "Payment" ("replacesPaymentId");

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_amendment_not_self"
  CHECK ("replacesPaymentId" IS NULL OR "replacesPaymentId" <> "id");

-- Archive = SOFT DELETE, mirroring User.deletedAt. It hides a row from the
-- register. NO report, shift closure or BIR register reads it, exactly as none
-- of them read User.deletedAt — a soft-deleted member's past payments still
-- count. Archiving changes what is shown, never what is counted.
ALTER TABLE "Payment" ADD COLUMN "archivedAt"   TIMESTAMPTZ(3);
ALTER TABLE "Payment" ADD COLUMN "archivedById" UUID;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_archivedById_fkey"
  FOREIGN KEY ("archivedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_archive_shape"
  CHECK (("archivedAt" IS NULL) = ("archivedById" IS NULL));

-- The cross-row invariant "the replaced row is VOIDED" has no row-level CHECK
-- representation. It is enforced by the service's guarded updateMany and
-- asserted in test/constraints.e2e-spec.ts. It was not forgotten.
