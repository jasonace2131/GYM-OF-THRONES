-- Hand-written for the same reason every migration since
-- 20260827010000_payment_void_kind has been: `prisma migrate dev` still
-- refuses against the shared dev database over checksum drift on
-- 20260820010000_chunk2_station_attendance and offers only a reset.
--
-- "How many walk-ins became members" is a number the Reports screen shows
-- and nothing could compute: a converted guest's rows look exactly like any
-- other guest's. This is the join, written once by POST /members when staff
-- convert the visit.
--
-- Deliberately NOT a back-fill of `userId`: that column stays NULL because
-- the visit really was taken by somebody with no account, and setting it
-- would collide with CheckIn_open_marker_agrees on an open row.

ALTER TABLE "CheckIn" ADD COLUMN "convertedToUserId" UUID;

ALTER TABLE "CheckIn"
  ADD CONSTRAINT "CheckIn_convertedToUserId_fkey"
  FOREIGN KEY ("convertedToUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Only a GUEST visit can convert: a visit that already has an account has
-- nothing to convert into. Checked here rather than in the service so a
-- future caller cannot quietly write a nonsense row.
ALTER TABLE "CheckIn"
  ADD CONSTRAINT "CheckIn_converted_guest_only" CHECK (
    "convertedToUserId" IS NULL OR "userId" IS NULL
  );

CREATE INDEX "CheckIn_convertedToUserId_idx" ON "CheckIn" ("convertedToUserId");
