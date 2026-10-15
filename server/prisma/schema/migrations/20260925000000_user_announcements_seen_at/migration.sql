-- Member announcements watermark: every notice created at or before this instant
-- counts as seen. NULL = never opened the bell; the API reads it as the account's
-- createdAt floored by a 30-day horizon (announcement-watermark.ts), so there is
-- no default, no backfill and no write on the provisioning hot path.
-- Nullable + no default = catalog-only ALTER. main never names the column; it
-- still ships only when the branch merges (CLAUDE.md).
ALTER TABLE "User" ADD COLUMN "announcementsSeenAt" TIMESTAMPTZ(3);
