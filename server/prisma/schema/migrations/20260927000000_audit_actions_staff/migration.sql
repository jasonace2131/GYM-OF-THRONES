-- ALONE IN ITS OWN MIGRATION ON PURPOSE. On PostgreSQL 15 a value added by
-- ALTER TYPE ... ADD VALUE cannot be referenced until the adding transaction
-- commits, and Prisma runs each migration file inside one transaction.
-- Nothing in this file uses them; the next migration is free to.
--
-- Staff & Access: an invitation issued, re-sent with a fresh link, withdrawn
-- and taken up — and an admin editing a coach's public profile.
ALTER TYPE "AuditAction" ADD VALUE 'STAFF_INVITED';
ALTER TYPE "AuditAction" ADD VALUE 'STAFF_INVITE_RESENT';
ALTER TYPE "AuditAction" ADD VALUE 'STAFF_INVITE_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'STAFF_INVITE_ACCEPTED';
ALTER TYPE "AuditAction" ADD VALUE 'COACH_PROFILE_UPDATED';
