-- Archive for the Notifications panel's expiry alerts (owner, 2026-10-08).
--
-- The alerts are derived from memberships, so the archive lives on the row:
-- `expiryAlertArchivedFor` holds the end date it was archived against and is
-- compared with "endsOn" on read. A renewal moves "endsOn", and the next term's
-- alert returns without anything clearing these columns.
--
-- Both columns nullable and added without a default: no rewrite of the table,
-- and every existing row reads as "not archived".

ALTER TABLE "Membership"
  ADD COLUMN "expiryAlertArchivedFor" DATE,
  ADD COLUMN "expiryAlertArchivedAt" TIMESTAMPTZ(3);

-- Both set or both null. test/membership-constraints.e2e-spec.ts asserts it.
ALTER TABLE "Membership"
  ADD CONSTRAINT "Membership_expiry_alert_archive_shape"
    CHECK (("expiryAlertArchivedFor" IS NULL) = ("expiryAlertArchivedAt" IS NULL));
