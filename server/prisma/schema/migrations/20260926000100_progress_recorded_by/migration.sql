-- Hand-written: prisma migrate dev refuses on the shared dev DB (checksum drift).
-- ADDITIVE: nullable, no default, NO BACKFILL. NULL recordedById is the only spelling
-- of "self-recorded" (every earlier row, and anything main's old code writes during
-- the deploy window).
ALTER TABLE "BodyMeasurement" ADD COLUMN "recordedById" UUID;
ALTER TABLE "BodyMeasurement" ADD COLUMN "updatedById"  UUID;
ALTER TABLE "MemberGoal"      ADD COLUMN "recordedById" UUID;
ALTER TABLE "MemberGoal"      ADD COLUMN "updatedById"  UUID;

-- RESTRICT, like CheckIn/Payment.recordedById: accounts are soft-deleted, and a coach
-- named on a member's record cannot be hard-deleted from under it. The member FK
-- stays CASCADE.
ALTER TABLE "BodyMeasurement" ADD CONSTRAINT "BodyMeasurement_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BodyMeasurement" ADD CONSTRAINT "BodyMeasurement_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberGoal" ADD CONSTRAINT "MemberGoal_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberGoal" ADD CONSTRAINT "MemberGoal_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Self-recorded is NULL, never the member's own id.
ALTER TABLE "BodyMeasurement" ADD CONSTRAINT "BodyMeasurement_recorder_not_member"
  CHECK ("recordedById" IS NULL OR "recordedById" <> "userId");
ALTER TABLE "MemberGoal" ADD CONSTRAINT "MemberGoal_recorder_not_member"
  CHECK ("recordedById" IS NULL OR "recordedById" <> "userId");

-- Self-recorded rows are frozen (D2): an updater on a row with no recorder is that rule broken.
ALTER TABLE "BodyMeasurement" ADD CONSTRAINT "BodyMeasurement_updater_shape"
  CHECK ("updatedById" IS NULL OR "recordedById" IS NOT NULL);
ALTER TABLE "MemberGoal" ADD CONSTRAINT "MemberGoal_updater_shape"
  CHECK ("updatedById" IS NULL OR "recordedById" IS NOT NULL);
