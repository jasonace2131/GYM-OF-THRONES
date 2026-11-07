-- Edit role access (feat/role-access-editor, owner 2026-11-07): one audit action.
--
-- ALONE ON PURPOSE (see 20260922000000_*): a value added by ALTER TYPE ... ADD VALUE
-- cannot be used in the transaction that adds it, and Prisma runs each file in one.
--
--   ROLE_PERMISSIONS_UPDATED  what a role can do, changed or reset to defaults
--                             ({ role, reset, added, removed, changed } — keys
--                              and reaches only)
ALTER TYPE "AuditAction" ADD VALUE 'ROLE_PERMISSIONS_UPDATED';
