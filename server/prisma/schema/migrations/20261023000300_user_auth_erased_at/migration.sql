-- Member self-deletion (owner, 2026-10-23): when the member's Supabase identity
-- was confirmed gone.
--
-- The local anonymisation commits FIRST and the Supabase delete runs after it,
-- so a Supabase outage can never leave real personal data behind. NULL on a
-- self-deleted row (email '...@deleted.invalid') means the identity erasure is
-- still owed; the scheduler's eraseDeletedAuth job retries it until Supabase
-- deletes it or answers "not found". Nullable, no default, no backfill: every
-- existing row is either live or a staff soft-delete, and neither is owed one.
ALTER TABLE "User" ADD COLUMN "authErasedAt" TIMESTAMPTZ(3);
