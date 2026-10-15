-- ALONE ON PURPOSE (see 20260922000000_*): a value added by ALTER TYPE ... ADD VALUE
-- cannot be used in the transaction that adds it, and Prisma runs each file in one.
ALTER TYPE "AuditAction" ADD VALUE 'PROGRESS_MEASUREMENT_CORRECTED';
ALTER TYPE "AuditAction" ADD VALUE 'PROGRESS_MEASUREMENT_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'PROGRESS_GOAL_DELETED';
