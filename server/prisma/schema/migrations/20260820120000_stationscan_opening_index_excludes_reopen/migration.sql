-- ============================================================================
-- Fix: `StationScan_opening_checkin_once` made §6.6.4's reopen impossible.
--
-- The index's stated invariant is "at most one OPENING scan per visit", and
-- that is the right invariant — two scans both claiming to have opened one
-- `CheckIn` is a service bug worth a loud 23505. But the filter shipped as
--
--     WHERE "outcome" IN ('CHECKED_IN', 'RECHECKED_IN', 'REOPENED')
--
-- and a REOPEN IS NOT AN OPENING. §6.6.4's undo path is, precisely, a scan
-- that reopens a visit which ALREADY HAS an opening scan — so the sequence the
-- design mandates (scan -> CHECKED_IN, scan -> CHECKED_OUT, scan within 20 min
-- -> REOPENED) collided with the original row on `checkInId` and 500'd the
-- member at the counter.
--
-- Caught by `test/checkin.e2e-spec.ts`'s reopen case. The reopen is bounded by
-- `CheckIn.reopenCount`, which is recorded rather than hidden so a dispute can
-- see a visit was closed and reopened — that is the audit trail here, not this
-- index.
--
-- Written as its own migration rather than an edit to
-- 20260820010000_chunk2_station_attendance: that one is already applied to the
-- development database, and editing an applied migration puts every
-- environment on a different schema with the same checksum.
-- ============================================================================

DROP INDEX IF EXISTS "StationScan_opening_checkin_once";

CREATE UNIQUE INDEX "StationScan_opening_checkin_once"
  ON "StationScan" ("checkInId")
  WHERE "outcome" IN ('CHECKED_IN', 'RECHECKED_IN');
