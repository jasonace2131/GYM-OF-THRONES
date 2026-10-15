-- ALONE ON PURPOSE (see 20260922000000_*): a value added by ALTER TYPE ... ADD VALUE
-- cannot be used in the transaction that adds it, and Prisma runs each file in one.
-- Announcements were unaudited until now; posting, editing (including pin/unpin)
-- and deleting a notice every member reads now leaves a name and a time.
ALTER TYPE "AuditAction" ADD VALUE 'ANNOUNCEMENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'ANNOUNCEMENT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'ANNOUNCEMENT_DELETED';
