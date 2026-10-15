-- ============================================================================
-- Fix: `CheckIn_open_marker_agrees` made an OPEN GUEST VISIT impossible.
--
-- The constraint shipped as a plain biconditional:
--
--     ("endedAt" IS NULL) = ("openUserId" IS NOT NULL)
--
-- and its reasoning is sound FOR A MEMBER: an UPDATE that omits the sentinel
-- would leave a visit open but invisible to `CheckIn_openUserId_key`, letting
-- a second visit open concurrently for the same person.
--
-- But `openUserId` is a PER-USER sentinel, and an off-the-street walk-in guest
-- HAS NO USER ROW BY DESIGN — a walk-in is a sale plus an entry, not a signup.
-- Such a row necessarily carries `openUserId IS NULL`, so the biconditional
-- forced `endedAt` to be set at insert: every guest was recorded as having
-- already left at the instant they arrived. The "who is in the building" board
-- could therefore never show a walk-in guest, and their session length was
-- always zero.
--
-- The exemption is safe because `CheckIn_open_marker` — unchanged, directly
-- above — already guarantees a row with no `userId` can never hold a sentinel:
--
--     "openUserId" IS NULL OR ("userId" IS NOT NULL AND "openUserId" = "userId")
--
-- So for an account-less row there is nothing for the unique index to protect:
-- there is no second visit to collide with, because there is no identity to
-- collide on. For every row that HAS a `userId` the original biconditional
-- still holds, unchanged.
--
-- Found by building the walk-in sale (route 49), not by review — the same way
-- StationScan_opening_checkin_once was found by building the reopen path.
-- ============================================================================

ALTER TABLE "CheckIn" DROP CONSTRAINT IF EXISTS "CheckIn_open_marker_agrees";

ALTER TABLE "CheckIn"
  ADD CONSTRAINT "CheckIn_open_marker_agrees" CHECK (
    -- An account-less guest: no sentinel to hold, so `endedAt` is free.
    ("userId" IS NULL AND "openUserId" IS NULL)
    -- Everyone else: the sentinel and the close move together, in both
    -- directions, and cannot be forgotten.
    OR (("endedAt" IS NULL) = ("openUserId" IS NOT NULL))
  );
