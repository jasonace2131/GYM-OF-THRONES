-- Rename the default role MEMBER -> CLIENT.
--
-- Anyone can register for free without buying a membership, so "MEMBER" read
-- as "someone who pays" when it actually means "any non-staff account holder".
-- Membership is separate state with its own dates and lifecycle; it is never
-- a role.
--
-- ALTER TYPE ... RENAME VALUE is non-destructive: existing rows and the
-- column default follow the rename automatically, so no backfill is needed.
ALTER TYPE "Role" RENAME VALUE 'MEMBER' TO 'CLIENT';

-- Body metrics, metric units, both optional.
--
-- Height is effectively static for adults, so a column is right. weightKg
-- holds the CURRENT reading for display; progress history belongs in its own
-- table when that feature lands, which will not change this column.
ALTER TABLE "User" ADD COLUMN "heightCm" DOUBLE PRECISION;
ALTER TABLE "User" ADD COLUMN "weightKg" DOUBLE PRECISION;
