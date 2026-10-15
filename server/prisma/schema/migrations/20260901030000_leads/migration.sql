-- ============================================================================
-- Leads — enquiries from people who have not joined.
--
-- The first table in this schema written by an UNAUTHENTICATED caller, which
-- shapes every constraint below: each one assumes the input is hostile until
-- proven otherwise, because a public POST is the one door with no guard chain
-- in front of it.
-- ============================================================================

CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'CONVERTED', 'LOST');

CREATE TABLE "Lead" (
  "id"              UUID           NOT NULL,
  "name"            TEXT           NOT NULL,
  "email"           TEXT,
  "phone"           TEXT,
  "message"         TEXT,
  "source"          TEXT           NOT NULL DEFAULT 'WEBSITE',
  "status"          "LeadStatus"   NOT NULL DEFAULT 'NEW',
  "assignedToId"    UUID,
  "notes"           TEXT,
  "convertedUserId" UUID,
  "convertedAt"     TIMESTAMPTZ(3),
  "emailSent"       BOOLEAN        NOT NULL DEFAULT false,
  "originIpHash"    CHAR(64),
  "createdAt"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Lead_status_createdAt_idx" ON "Lead"("status", "createdAt" DESC);
CREATE INDEX "Lead_assignedToId_status_idx" ON "Lead"("assignedToId", "status");

-- SET NULL, not RESTRICT: a staff member leaving must not be un-deletable
-- because they once owned an enquiry, and a converted member exercising
-- erasure must not be blocked by the lead that preceded them.
ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Lead_convertedUserId_fkey"
  FOREIGN KEY ("convertedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_name_sane" CHECK (
    char_length(btrim("name")) BETWEEN 1 AND 120
  ),
  -- Deliberately NOT a full RFC 5322 pattern. A regex strict enough to be
  -- correct rejects real addresses, and this column's job is to be repliable,
  -- not provably valid. One '@', something on each side, a sane length.
  ADD CONSTRAINT "Lead_email_sane" CHECK (
    "email" IS NULL OR (
      char_length("email") BETWEEN 5 AND 254 AND "email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    )
  ),
  ADD CONSTRAINT "Lead_phone_sane" CHECK (
    "phone" IS NULL OR char_length(btrim("phone")) BETWEEN 7 AND 20
  ),
  -- 2000 characters is a long enquiry and a short essay. The cap is what
  -- stops a public endpoint being used to write megabytes into the database.
  ADD CONSTRAINT "Lead_message_sane" CHECK (
    "message" IS NULL OR char_length("message") BETWEEN 1 AND 2000
  ),
  ADD CONSTRAINT "Lead_notes_sane" CHECK (
    "notes" IS NULL OR char_length("notes") BETWEEN 1 AND 4000
  ),
  ADD CONSTRAINT "Lead_source_sane" CHECK (
    char_length(btrim("source")) BETWEEN 1 AND 40
  ),
  -- A lead with no way to reach them is not a lead, it is noise. The form
  -- requires one; this makes it true of every row regardless of caller.
  ADD CONSTRAINT "Lead_contactable" CHECK (
    "email" IS NOT NULL OR "phone" IS NOT NULL
  ),
  -- CONVERTED and the conversion facts move together, in both directions —
  -- the same shape rule Payment_void_shape and User_suspend_shape use.
  ADD CONSTRAINT "Lead_converted_shape" CHECK (
    ("status" = 'CONVERTED') = ("convertedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "Lead_iphash_shape" CHECK (
    "originIpHash" IS NULL OR "originIpHash" ~ '^[0-9a-f]{64}$'
  );
