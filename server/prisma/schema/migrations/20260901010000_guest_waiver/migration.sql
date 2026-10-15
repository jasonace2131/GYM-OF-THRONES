-- ============================================================================
-- The walk-in guest's waiver.
--
-- A guest has no `User` row, so a `ConsentRecord` cannot hold their
-- acceptance — the FK has nothing to point at, and creating a shadow account
-- for somebody who explicitly did not want one is worse than the problem.
--
-- So it lives on the VISIT. That is also the more accurate model: a member
-- consents once and it stands until the wording changes; a guest consents for
-- one entry, because there is no ongoing relationship for it to persist into.
-- ============================================================================

ALTER TABLE "CheckIn"
  ADD COLUMN "guestWaiverVersion"     TEXT,
  ADD COLUMN "guestWaiverAcceptedAt"  TIMESTAMPTZ(3),
  ADD COLUMN "guestEmergencyContact"  TEXT;

ALTER TABLE "CheckIn"
  -- Both halves of the acceptance, or neither. A version with no timestamp
  -- cannot say when, and a timestamp with no version cannot say to what —
  -- either alone is unusable as evidence, which is the failure mode of the
  -- boolean this replaces.
  ADD CONSTRAINT "CheckIn_guest_waiver_paired" CHECK (
    ("guestWaiverVersion" IS NULL) = ("guestWaiverAcceptedAt" IS NULL)
  ),
  ADD CONSTRAINT "CheckIn_guest_waiver_sane" CHECK (
    "guestWaiverVersion" IS NULL OR char_length(btrim("guestWaiverVersion")) BETWEEN 1 AND 40
  ),
  ADD CONSTRAINT "CheckIn_guest_emergency_sane" CHECK (
    "guestEmergencyContact" IS NULL OR char_length(btrim("guestEmergencyContact")) BETWEEN 1 AND 200
  );

-- ── The rule that matters, and why it is NOT VALID ──────────────────────────
--
-- Every NEW account-less walk-in must carry a waiver. Existing rows cannot:
-- they were written before the column existed, and back-filling them would be
-- fabricating evidence that a person agreed to something they were never
-- shown. That is a far worse outcome than an honest gap in the history.
--
-- `NOT VALID` is exactly this tool: Postgres enforces the constraint on every
-- INSERT and UPDATE from now on, and does not scan what is already there. Do
-- NOT run `VALIDATE CONSTRAINT` on it later — that would fail, and the only
-- way to make it pass would be to invent the missing acceptances.
ALTER TABLE "CheckIn"
  ADD CONSTRAINT "CheckIn_guest_waiver_required" CHECK (
    "entryType" <> 'WALK_IN'
    OR "userId" IS NOT NULL
    OR "guestWaiverVersion" IS NOT NULL
  ) NOT VALID;
