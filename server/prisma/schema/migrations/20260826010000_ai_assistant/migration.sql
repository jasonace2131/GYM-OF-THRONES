-- The member assistant's conversation history.

CREATE TABLE "AiConversation" (
    "id"        UUID           NOT NULL,
    "userId"    UUID           NOT NULL,
    "title"     TEXT           NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiMessage" (
    "id"             UUID           NOT NULL,
    "conversationId" UUID           NOT NULL,
    "role"           TEXT           NOT NULL,
    "content"        TEXT           NOT NULL,
    "toolCallCount"  INTEGER        NOT NULL DEFAULT 0,
    "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiConversation_userId_updatedAt_idx"
    ON "AiConversation" ("userId", "updatedAt" DESC);
CREATE INDEX "AiMessage_conversationId_createdAt_idx"
    ON "AiMessage" ("conversationId", "createdAt");

-- CASCADE, unlike almost everything else in this schema. A conversation is not
-- a business record: no report reconciles against it and no money moves through
-- it, so a deleted member's chat log is a liability to keep rather than an
-- audit trail to preserve.
ALTER TABLE "AiConversation"
    ADD CONSTRAINT "AiConversation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiMessage"
    ADD CONSTRAINT "AiMessage_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiMessage"
    ADD CONSTRAINT "AiMessage_role_known"
    CHECK ("role" IN ('USER', 'ASSISTANT'));

ALTER TABLE "AiMessage"
    ADD CONSTRAINT "AiMessage_content_sane"
    CHECK (char_length(btrim("content")) BETWEEN 1 AND 20000);

ALTER TABLE "AiConversation"
    ADD CONSTRAINT "AiConversation_title_sane"
    CHECK (char_length(btrim("title")) BETWEEN 1 AND 120);

ALTER TABLE "AiMessage"
    ADD CONSTRAINT "AiMessage_tool_calls_sane"
    CHECK ("toolCallCount" >= 0);

-- Same lock every other table carries: Supabase's default grants give `anon`
-- — the key compiled into the browser bundle — full DML across the public
-- schema, and a chat log is exactly the kind of table that must not be
-- readable through the REST API.
ALTER TABLE "AiConversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiMessage"      ENABLE ROW LEVEL SECURITY;

DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "AiConversation", "AiMessage" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "AiConversation", "AiMessage" FROM authenticated';
  END IF;
END
$rls$;
