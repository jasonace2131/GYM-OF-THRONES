-- AI assistant settings (feat/assistant-settings): two audit actions.
--
-- ALONE ON PURPOSE (see 20260922000000_*): a value added by ALTER TYPE ... ADD VALUE
-- cannot be used in the transaction that adds it, and Prisma runs each file in one.
--
--   ASSISTANT_INSTRUCTIONS_UPDATED  an admin saved new assistant instructions
--   ASSISTANT_INSTRUCTIONS_RESET    an admin put the built-in instructions back
ALTER TYPE "AuditAction" ADD VALUE 'ASSISTANT_INSTRUCTIONS_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'ASSISTANT_INSTRUCTIONS_RESET';
