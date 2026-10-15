-- ALONE IN ITS OWN MIGRATION ON PURPOSE. On PostgreSQL 15 a value added by
-- ALTER TYPE ... ADD VALUE cannot be referenced until the adding transaction
-- commits, and Prisma runs each migration file inside one transaction.
-- Nothing in this file uses them; the next migration is free to.
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_AMENDED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_UNARCHIVED';
