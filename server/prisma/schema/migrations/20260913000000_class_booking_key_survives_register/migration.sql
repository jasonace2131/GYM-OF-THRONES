-- One non-cancelled booking per member per class, kept by the activeKey
-- sentinel for EVERY non-cancelled row: BOOKED, WAITLISTED, ATTENDED, NO_SHOW.
--
-- Previously the key was cleared when the register was marked. A member marked
-- early could then book the same class again and take a second seat
-- (production, 2026-09-09, Yoga on Wed 16 Sep). A partial unique index would
-- also work, but Prisma drops partial indexes on the next unrelated migrate --
-- the reason this table has a sentinel column in the first place.

DO $dup$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ClassBooking"
    WHERE "status" <> 'CANCELLED'
    GROUP BY "sessionId", "userId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'ClassBooking has a member with more than one non-cancelled row for the same class. Cancel the duplicates before applying this migration.';
  END IF;
END
$dup$;

ALTER TABLE "ClassBooking" DROP CONSTRAINT "ClassBooking_active_key_shape";

UPDATE "ClassBooking"
SET "activeKey" = "sessionId"::text || ':' || "userId"::text
WHERE "status" IN ('ATTENDED', 'NO_SHOW')
  AND "activeKey" IS NULL;

ALTER TABLE "ClassBooking"
  ADD CONSTRAINT "ClassBooking_active_key_shape"
  CHECK (("status" <> 'CANCELLED') = ("activeKey" IS NOT NULL));
