-- Hand-written, like 20260827010000_payment_void_kind before it: `prisma
-- migrate dev` still refuses over checksum drift on
-- 20260820010000_chunk2_station_attendance and offers only a reset, so this
-- file is authored by hand and applied with `migrate deploy`, which does not
-- re-verify applied checksums.
--
-- GCash recording, hardened without a payment API and without a screenshot:
-- the normalized reference + a partial unique index (a reused "proof" is,
-- definitionally, a duplicate reference — the one fraud pattern catchable
-- in-database), plus a named staff attestation that the payment was seen in
-- the gym's own GCash Transactions tab.
--
-- Order matters: backfill BEFORE the CHECK, CHECK before the index.

ALTER TABLE "Payment"
  ADD COLUMN "referenceNormalized" TEXT,
  ADD COLUMN "gcashVerifiedAt"     TIMESTAMPTZ(3),
  ADD COLUMN "gcashVerifiedById"   UUID;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_gcashVerifiedById_fkey"
  FOREIGN KEY ("gcashVerifiedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill BEFORE the CHECK, or every existing row with a reference
-- violates it the moment the constraint lands.
UPDATE "Payment"
   SET "referenceNormalized" = upper(regexp_replace("reference", '[^A-Za-z0-9]', '', 'g'))
 WHERE "reference" IS NOT NULL;

-- Biconditional on `reference`, not on `method`: a CASH row is allowed to
-- carry a reference today (nothing forbids it), and if it does, it
-- normalizes too. The unique index below excludes it by predicate.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_reference_normalized_shape" CHECK (
    ("reference" IS NULL) = ("referenceNormalized" IS NULL)
    AND ("referenceNormalized" IS NULL OR "referenceNormalized" ~ '^[A-Z0-9]+$')
  );

-- Same shape rule as Payment_void_kind_shape: the pair moves together, and
-- an attestation about a GCash transaction on a CASH row is nonsense.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_gcash_verified_shape" CHECK (
    ("gcashVerifiedAt" IS NULL) = ("gcashVerifiedById" IS NULL)
    AND ("gcashVerifiedAt" IS NULL OR "method" = 'GCASH')
  );

-- THE fraud control. A reused screenshot is, definitionally, a duplicate
-- reference. VOIDED excluded so a mis-keyed reference can be voided and
-- re-entered. All-time scope is correct: GCash references do not expire.
--
-- IF THIS FAILS, the database already holds two live rows with the same
-- normalized reference. Find them, void the wrong one, re-run:
--   SELECT "referenceNormalized", count(*) FROM "Payment"
--    WHERE "method" = 'GCASH' AND "status" <> 'VOIDED'
--      AND "referenceNormalized" IS NOT NULL
--    GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX "Payment_gcash_reference_unique"
    ON "Payment" ("referenceNormalized")
 WHERE "method" = 'GCASH' AND "status" <> 'VOIDED';
