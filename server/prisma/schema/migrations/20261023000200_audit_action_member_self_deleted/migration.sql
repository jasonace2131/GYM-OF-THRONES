-- Member self-service account deletion (owner, 2026-10-23): one audit action.
--
-- ALONE ON PURPOSE (see 20260922000000_*): a value added by ALTER TYPE ... ADD VALUE
-- cannot be used in the transaction that adds it, and Prisma runs each file in one.
--
--   MEMBER_SELF_DELETED  a member deleted their own account; personal data was
--                        anonymised and payments/attendance kept
--                        ({ bookingsCancelled, visitClosed, coachAssignmentEnded,
--                           personalRecordsDeleted, hadActivePlan } — counts only)
ALTER TYPE "AuditAction" ADD VALUE 'MEMBER_SELF_DELETED';
