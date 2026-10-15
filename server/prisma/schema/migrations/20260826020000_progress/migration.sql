-- Member progress: body measurements and goals.
-- The workout log the mock screen showed is deliberately not built — a
-- sets-and-reps journal is a training-log product, not a gym CRM.

CREATE TABLE "BodyMeasurement" (
    "id"              UUID           NOT NULL,
    "userId"          UUID           NOT NULL,
    "businessDate"    DATE           NOT NULL,
    "weightGrams"     INTEGER,
    "heightMm"        INTEGER,
    "bodyFatPermille" INTEGER,
    "notes"           TEXT,
    "createdAt"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BodyMeasurement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemberGoal" (
    "id"                UUID           NOT NULL,
    "userId"            UUID           NOT NULL,
    "name"              TEXT           NOT NULL,
    "unit"              TEXT           NOT NULL,
    "startHundredths"   INTEGER        NOT NULL,
    "currentHundredths" INTEGER        NOT NULL,
    "targetHundredths"  INTEGER        NOT NULL,
    "achievedAt"        TIMESTAMPTZ(3),
    "createdAt"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MemberGoal_pkey" PRIMARY KEY ("id")
);

-- One entry per member per day. Weighing yourself twice in a morning corrects
-- the day's row rather than putting a sawtooth in the trend line; the write
-- path upserts on this key.
CREATE UNIQUE INDEX "BodyMeasurement_userId_businessDate_key"
    ON "BodyMeasurement" ("userId", "businessDate");
CREATE INDEX "BodyMeasurement_userId_businessDate_idx"
    ON "BodyMeasurement" ("userId", "businessDate" DESC);
CREATE INDEX "MemberGoal_userId_achievedAt_createdAt_idx"
    ON "MemberGoal" ("userId", "achievedAt", "createdAt" DESC);

-- CASCADE: this is the member's own body data, not a business record. When the
-- account goes it should go with it — keeping a deleted member's weight
-- history is a liability, not an audit trail.
ALTER TABLE "BodyMeasurement"
    ADD CONSTRAINT "BodyMeasurement_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemberGoal"
    ADD CONSTRAINT "MemberGoal_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Plausible human ranges. These are not validation for its own sake: a typo of
-- 7240 instead of 72400 would rescale the whole trend chart and read as a
-- catastrophic weight loss.
ALTER TABLE "BodyMeasurement"
    ADD CONSTRAINT "BodyMeasurement_weight_sane"
    CHECK ("weightGrams" IS NULL OR "weightGrams" BETWEEN 20000 AND 400000);

ALTER TABLE "BodyMeasurement"
    ADD CONSTRAINT "BodyMeasurement_height_sane"
    CHECK ("heightMm" IS NULL OR "heightMm" BETWEEN 500 AND 2500);

ALTER TABLE "BodyMeasurement"
    ADD CONSTRAINT "BodyMeasurement_bodyfat_sane"
    CHECK ("bodyFatPermille" IS NULL OR "bodyFatPermille" BETWEEN 10 AND 700);

-- A row with a date and nothing else is not a measurement.
ALTER TABLE "BodyMeasurement"
    ADD CONSTRAINT "BodyMeasurement_not_empty"
    CHECK ("weightGrams" IS NOT NULL OR "heightMm" IS NOT NULL OR "bodyFatPermille" IS NOT NULL);

ALTER TABLE "MemberGoal"
    ADD CONSTRAINT "MemberGoal_name_sane"
    CHECK (char_length(btrim("name")) BETWEEN 1 AND 80);

ALTER TABLE "MemberGoal"
    ADD CONSTRAINT "MemberGoal_unit_sane"
    CHECK (char_length(btrim("unit")) BETWEEN 1 AND 12);

-- A goal whose target equals its start has no progress to show and would
-- divide by zero in every percentage the screen renders.
ALTER TABLE "MemberGoal"
    ADD CONSTRAINT "MemberGoal_target_differs"
    CHECK ("targetHundredths" <> "startHundredths");

ALTER TABLE "BodyMeasurement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MemberGoal"      ENABLE ROW LEVEL SECURITY;

DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "BodyMeasurement", "MemberGoal" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "BodyMeasurement", "MemberGoal" FROM authenticated';
  END IF;
END
$rls$;
