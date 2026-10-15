-- ============================================================================
-- Consent records, structured emergency contact, medical notes, date of birth.
--
-- Every CHECK in this repository lives in hand-written SQL like this and has
-- no Prisma representation, so a `migrate diff` or a local `db push` drops it
-- silently while every service test keeps passing. The constraint e2e specs
-- are the only thing that notices — keep them in CI.
-- ============================================================================

-- ── ConsentRecord ───────────────────────────────────────────────────────────
CREATE TYPE "ConsentKind" AS ENUM ('WAIVER', 'TERMS', 'PRIVACY');

CREATE TABLE "ConsentRecord" (
  "id"         UUID         NOT NULL,
  "userId"     UUID         NOT NULL,
  "kind"       "ConsentKind" NOT NULL,
  "version"    TEXT         NOT NULL,
  "acceptedAt" TIMESTAMPTZ(3) NOT NULL,
  "ipHash"     CHAR(64),
  "userAgent"  TEXT,
  "createdAt"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- One acceptance per user per document per version: a refresh or a
-- double-submit is idempotent, and a genuine re-acceptance only happens when
-- the version string changes.
CREATE UNIQUE INDEX "ConsentRecord_userId_kind_version_key"
  ON "ConsentRecord"("userId", "kind", "version");

CREATE INDEX "ConsentRecord_userId_kind_acceptedAt_idx"
  ON "ConsentRecord"("userId", "kind", "acceptedAt" DESC);

CREATE INDEX "ConsentRecord_kind_version_idx"
  ON "ConsentRecord"("kind", "version");

-- CASCADE, uniquely in this schema, where everything else is RESTRICT.
-- RA 10173 §16(e) gives a data subject the right to erasure. A consent record
-- is evidence ABOUT a person; once that person is gone it is not evidence of
-- anything and must not be what blocks their deletion.
ALTER TABLE "ConsentRecord"
  ADD CONSTRAINT "ConsentRecord_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConsentRecord"
  -- A version that is blank, or padded to look non-blank, cannot identify a
  -- document. This is the column the whole record hangs on.
  ADD CONSTRAINT "ConsentRecord_version_sane" CHECK (
    char_length(btrim("version")) BETWEEN 1 AND 40
  ),
  -- Hex, lowercase, exactly 64 — a SHA-256 digest and nothing else. CHAR(64)
  -- alone would happily store 64 spaces or a raw IPv6 address padded out,
  -- which is the failure this column exists to prevent.
  ADD CONSTRAINT "ConsentRecord_iphash_shape" CHECK (
    "ipHash" IS NULL OR "ipHash" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "ConsentRecord_agent_sane" CHECK (
    "userAgent" IS NULL OR char_length("userAgent") BETWEEN 1 AND 400
  );

-- ── User: member details that were collected and thrown away ────────────────
ALTER TABLE "User"
  ADD COLUMN "emergencyContactName"     TEXT,
  ADD COLUMN "emergencyContactPhone"    TEXT,
  ADD COLUMN "emergencyContactRelation" TEXT,
  ADD COLUMN "medicalNotes"             TEXT,
  ADD COLUMN "dateOfBirth"              DATE;

-- Back-fill the free-text column into the name field rather than dropping it.
-- Splitting "wife Maria 0917..." into three fields is a judgement a migration
-- must not make; a human re-enters it from the CRM drawer when they next open
-- the member. The legacy column stays so the rollback is not lossy.
UPDATE "User"
   SET "emergencyContactName" = "emergencyContact"
 WHERE "emergencyContact" IS NOT NULL
   AND btrim("emergencyContact") <> '';

ALTER TABLE "User"
  ADD CONSTRAINT "User_emergency_sane" CHECK (
    ("emergencyContactName"     IS NULL OR char_length(btrim("emergencyContactName"))     BETWEEN 1 AND 120) AND
    ("emergencyContactPhone"    IS NULL OR char_length(btrim("emergencyContactPhone"))    BETWEEN 1 AND 40)  AND
    ("emergencyContactRelation" IS NULL OR char_length(btrim("emergencyContactRelation")) BETWEEN 1 AND 40)
  ),
  ADD CONSTRAINT "User_medical_notes_sane" CHECK (
    "medicalNotes" IS NULL OR char_length("medicalNotes") BETWEEN 1 AND 2000
  ),
  -- Bounds, not policy. The minimum joining age is a business rule that lives
  -- in the DTO where it can change without a migration; this only rejects a
  -- date that cannot describe a living member — a typo'd year, or a birthday
  -- in the future. 120 years is the ceiling.
  ADD CONSTRAINT "User_dob_plausible" CHECK (
    "dateOfBirth" IS NULL OR (
      "dateOfBirth" <= CURRENT_DATE AND
      "dateOfBirth" >  CURRENT_DATE - INTERVAL '120 years'
    )
  );
