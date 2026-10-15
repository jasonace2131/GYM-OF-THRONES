-- Who did what to a class booking (class-booking fixes, 2026-10-11): the desk user
-- who added a member by hand, the desk user who took a member out (with the reason
-- the member is shown), and who marked the register entry, and when. Until now a
-- booking recorded none of it: every cancellation read as "You cancelled", and a
-- register mark could not say who made it.
--
-- The member's own actions leave the actor columns NULL. Only somebody ELSE is ever
-- named, which the two *_not_member CHECKs pin: a member's id under a RESTRICT key
-- on their own booking would make deleting that member depend on which foreign-key
-- trigger fires first (the CASCADE on "userId" or the RESTRICT check), and that
-- order follows trigger names, not intent.
--
-- Hand-written: prisma migrate dev refuses on the shared dev DB (checksum drift).
-- ADDITIVE: five nullable columns, no default, NO BACKFILL. NULL means "not
-- recorded" — every booking written before this migration, and anything main's old
-- code writes during the deploy window (migrate deploy runs before the new code
-- starts). Every rule below holds for a row that leaves all five NULL, so main's
-- code, both seeds (which write ATTENDED and NO_SHOW rows with no marker) and the
-- existing raw-insert tests keep working unchanged.
--
-- Every CHECK below lives ONLY here — Prisma cannot represent them — so
-- test/classes-constraints.e2e-spec.ts asserts each name AND predicate. Postgres
-- tests CHECKs in name order: five of these six sort after the four existing
-- ClassBooking CHECKs, but ClassBooking_booker_not_member sorts between the
-- existing attended_shape and cancelled_shape — worth knowing when a raw-insert
-- case trips more than one.

ALTER TABLE "ClassBooking"
  ADD COLUMN "bookedById"    UUID,
  ADD COLUMN "cancelledById" UUID,
  ADD COLUMN "removalReason" TEXT,
  ADD COLUMN "markedById"    UUID,
  ADD COLUMN "markedAt"      TIMESTAMPTZ(3);

-- RESTRICT, like every "who did it" column (BodyMeasurement.recordedById,
-- 20260926000100_progress_recorded_by): accounts are soft-deleted, and the name on a
-- member's booking cannot be hard-deleted out from under it. The member FK stays
-- CASCADE.
ALTER TABLE "ClassBooking" ADD CONSTRAINT "ClassBooking_bookedById_fkey"
  FOREIGN KEY ("bookedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassBooking" ADD CONSTRAINT "ClassBooking_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassBooking" ADD CONSTRAINT "ClassBooking_markedById_fkey"
  FOREIGN KEY ("markedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The desk adds a member; a member booking themselves leaves this NULL. A member's
-- own id here would read as "added by staff" and sit under a RESTRICT key on their
-- own row.
ALTER TABLE "ClassBooking" ADD CONSTRAINT "ClassBooking_booker_not_member"
  CHECK ("bookedById" IS NULL OR "bookedById" <> "userId");

-- The same rule for cancelling: a member cancelling their own place leaves this
-- NULL, so a canceller is always somebody else (the desk taking them out).
ALTER TABLE "ClassBooking" ADD CONSTRAINT "ClassBooking_canceller_not_member"
  CHECK ("cancelledById" IS NULL OR "cancelledById" <> "userId");

-- Only a cancelled booking has a canceller: a name on a live place would claim
-- somebody cancelled a booking that still holds its seat.
ALTER TABLE "ClassBooking" ADD CONSTRAINT "ClassBooking_canceller_shape"
  CHECK ("cancelledById" IS NULL OR "status" = 'CANCELLED');

-- Only a marked entry has a marking time. One-way on purpose, not the biconditional:
-- legacy NO_SHOW rows have no time to backfill from, and main's code and both seeds
-- write marked rows without one.
ALTER TABLE "ClassBooking" ADD CONSTRAINT "ClassBooking_marked_shape"
  CHECK ("markedAt" IS NULL OR "status" IN ('ATTENDED', 'NO_SHOW'));

-- A marker without a time cannot answer "when", which is half of why the columns
-- exist.
ALTER TABLE "ClassBooking" ADD CONSTRAINT "ClassBooking_marker_shape"
  CHECK ("markedById" IS NULL OR "markedAt" IS NOT NULL);

-- A removal reason belongs to a removal that names who made it, and is something the
-- member can read: 3-300 trimmed characters, the bounds RemoveFromClassDto enforces.
-- The trim names tabs and line breaks too (bare btrim() strips spaces only; see
-- 20261001000100_constraint_floor_fixes).
ALTER TABLE "ClassBooking" ADD CONSTRAINT "ClassBooking_removal_reason_shape"
  CHECK (
    "removalReason" IS NULL
    OR ("cancelledById" IS NOT NULL AND char_length(btrim("removalReason", E' \t\r\n')) BETWEEN 3 AND 300)
  );
