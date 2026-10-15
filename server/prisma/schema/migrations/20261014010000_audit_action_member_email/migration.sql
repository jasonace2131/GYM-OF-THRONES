-- Counter sign-up (feat/counter-signup): one audit action.
--
-- ALONE ON PURPOSE (see 20260922000000_*): a value added by ALTER TYPE ... ADD VALUE
-- cannot be used in the transaction that adds it, and Prisma runs each file in one.
--
--   MEMBER_EMAIL_CHANGED  staff corrected the email of a member who has never signed in
ALTER TYPE "AuditAction" ADD VALUE 'MEMBER_EMAIL_CHANGED';
