-- Coach tools (feat/coach-tools): three audit actions.
--
-- ALONE ON PURPOSE (see 20260922000000_*): a value added by ALTER TYPE ... ADD VALUE
-- cannot be used in the transaction that adds it, and Prisma runs each file in one.
--
--   CHAT_THREAD_REVIEWED  an admin read a coach-member conversation (chat.review)
--   CHAT_MESSAGE_DELETED  a sender withdrew their own message inside the window
--   WORKOUT_PLAN_SAVED    a coach saved a member's workout plan
ALTER TYPE "AuditAction" ADD VALUE 'CHAT_THREAD_REVIEWED';
ALTER TYPE "AuditAction" ADD VALUE 'CHAT_MESSAGE_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKOUT_PLAN_SAVED';
