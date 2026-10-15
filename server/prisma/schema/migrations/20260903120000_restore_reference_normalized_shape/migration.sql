-- Restores Payment_reference_normalized_shape at merge time.
--
-- Why it exists: main was force-reverted to pre-feature code while this
-- branch's 20260903000000 migration was already applied to the shared
-- database. Old code writes `reference` without `referenceNormalized`, which
-- that CHECK forbids — so the CHECK is dropped for the development window
-- (see the owner-run ALTER in the incident notes) and this migration brings
-- it back WITH a re-backfill, so rows written by the old code in the
-- meantime satisfy it. Idempotent on purpose: on a database where the CHECK
-- was never dropped (the e2e scratch DB), this still applies cleanly.

UPDATE "Payment"
   SET "referenceNormalized" = upper(regexp_replace("reference", '[^A-Za-z0-9]', '', 'g'))
 WHERE "reference" IS NOT NULL
   AND "referenceNormalized" IS NULL;

ALTER TABLE "Payment"
  DROP CONSTRAINT IF EXISTS "Payment_reference_normalized_shape";

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_reference_normalized_shape" CHECK (
    ("reference" IS NULL) = ("referenceNormalized" IS NULL)
    AND ("referenceNormalized" IS NULL OR "referenceNormalized" ~ '^[A-Z0-9]+$')
  );
