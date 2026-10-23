-- The gym equipment list (owner, 2026-10-23): one audit action.
--
-- ALONE ON PURPOSE (see 20260922000000_*): a value added by ALTER TYPE ... ADD VALUE
-- cannot be used in the transaction that adds it, and Prisma runs each file in one.
--
--   GYM_EQUIPMENT_CHANGED  an admin added, edited, removed or reordered equipment
--                          ({ change, before?, after? })
ALTER TYPE "AuditAction" ADD VALUE 'GYM_EQUIPMENT_CHANGED';
