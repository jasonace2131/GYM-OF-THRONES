-- ============================================================================
-- Per-weekday opening hours, editable by staff.
--
-- The environment variables remain the FALLBACK. A row here overrides them;
-- an empty table, an unreachable database or a malformed value falls back to
-- GYM_OPEN_TIME / GYM_CLOSE_TIME, which are validated at boot. That is what
-- keeps "editable from a browser" from becoming "the front desk stops at
-- 06:00 and nobody knows why".
-- ============================================================================

CREATE TABLE "GymHours" (
  "dayOfWeek"   INTEGER        NOT NULL,
  "opensAt"     TEXT           NOT NULL,
  "closesAt"    TEXT           NOT NULL,
  "isClosed"    BOOLEAN        NOT NULL DEFAULT false,
  "updatedById" UUID,
  "updatedAt"   TIMESTAMPTZ(3) NOT NULL,

  -- The weekday IS the primary key, so a second row for Tuesday is impossible
  -- rather than merely unlikely. Hours that disagree with themselves is the
  -- failure this table most needs to not have.
  CONSTRAINT "GymHours_pkey" PRIMARY KEY ("dayOfWeek")
);

ALTER TABLE "GymHours"
  ADD CONSTRAINT "GymHours_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GymHours"
  ADD CONSTRAINT "GymHours_day_valid" CHECK ("dayOfWeek" BETWEEN 0 AND 6),
  -- 'HH:mm', 24-hour, and nothing else. A time this table cannot parse is a
  -- time the door gate cannot enforce, so it is refused at the column rather
  -- than surfacing as a member being wrongly denied at 05:59.
  ADD CONSTRAINT "GymHours_opens_shape"  CHECK ("opensAt"  ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT "GymHours_closes_shape" CHECK ("closesAt" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- Closing before opening is a typo, not a schedule. Equal is also refused:
  -- it reads as either "closed" or "open 24 hours" depending on who is
  -- looking, and `isClosed` says the first one without ambiguity.
  ADD CONSTRAINT "GymHours_ordered" CHECK ("isClosed" OR "closesAt" > "opensAt");

-- Seeded from the environment's own defaults, so applying this migration
-- changes NOTHING until somebody edits the hours in the console. A table that
-- silently altered the door's behaviour on deploy would be exactly the
-- failure mode the fallback exists to prevent.
INSERT INTO "GymHours" ("dayOfWeek", "opensAt", "closesAt", "isClosed", "updatedAt")
SELECT d, '05:00', '22:00', false, CURRENT_TIMESTAMP
  FROM generate_series(0, 6) AS d;
