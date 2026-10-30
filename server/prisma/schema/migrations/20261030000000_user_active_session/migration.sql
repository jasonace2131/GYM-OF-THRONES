-- One device at a time (owner, 2026-10-30). Hand-written.
--
-- The Supabase sign-in (`session_id`) currently allowed to use the account,
-- and when that sign-in happened (its latest `amr` timestamp). A newer
-- verified sign-in takes the pair over; the older device's next request is
-- answered 401 SESSION_REPLACED. See server/src/auth/single-session.service.ts.
--
-- ADDITIVE: both nullable, no default, no backfill. NULL means "no device has
-- claimed the account yet", and the first verified request claims it, so every
-- existing row starts unclaimed and main's old code, which never names these
-- columns, is unaffected.
ALTER TABLE "User" ADD COLUMN "activeSessionId" UUID;
ALTER TABLE "User" ADD COLUMN "activeSessionSignedInAt" TIMESTAMPTZ(3);
