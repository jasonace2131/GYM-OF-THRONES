-- The emailed sign-in code (feat/login-code, 2026-10-15).
--
-- Hand-written: prisma migrate dev refuses on the shared dev DB (checksum drift).
-- ADDITIVE ONLY: one new table. main's code never reads it, so it keeps running
-- against this schema during the deploy window.
--
-- Every CHECK below lives ONLY here — Prisma cannot represent them — so
-- test/login-code-constraints.e2e-spec.ts asserts each name AND predicate.

-- ONE ROW PER SUPABASE SIGN-IN, keyed by the access token's `session_id`.
CREATE TABLE "LoginVerification" (
    "sessionId"     UUID           NOT NULL,
    "userId"        UUID           NOT NULL,
    "codeHash"      CHAR(64),
    "codeExpiresAt" TIMESTAMPTZ(3),
    "attempts"      INTEGER        NOT NULL DEFAULT 0,
    "sendCount"     INTEGER        NOT NULL DEFAULT 0,
    "lastSentAt"    TIMESTAMPTZ(3),
    "verifiedAt"    TIMESTAMPTZ(3),
    "createdAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginVerification_pkey" PRIMARY KEY ("sessionId")
);

-- The per-account hourly ceiling sums this user's rows.
CREATE INDEX "LoginVerification_userId_idx" ON "LoginVerification"("userId");

-- CASCADE: a sign-in's code is meaningless without its account.
ALTER TABLE "LoginVerification" ADD CONSTRAINT "LoginVerification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- HMAC-SHA256, hex. Never the code itself.
ALTER TABLE "LoginVerification" ADD CONSTRAINT "LoginVerification_code_hash_shape"
    CHECK ("codeHash" IS NULL OR "codeHash" ~ '^[0-9a-f]{64}$');

-- Five wrong guesses burn the code (LOGIN_CODE_MAX_ATTEMPTS).
ALTER TABLE "LoginVerification" ADD CONSTRAINT "LoginVerification_attempts_range"
    CHECK ("attempts" BETWEEN 0 AND 5);

-- Five codes per sign-in (LOGIN_CODE_MAX_SENDS_PER_SIGN_IN).
ALTER TABLE "LoginVerification" ADD CONSTRAINT "LoginVerification_send_count_range"
    CHECK ("sendCount" BETWEEN 0 AND 5);

-- A live code always has an expiry; a cleared one has neither.
ALTER TABLE "LoginVerification" ADD CONSTRAINT "LoginVerification_code_pair"
    CHECK (("codeHash" IS NULL) = ("codeExpiresAt" IS NULL));

-- The API writes both from its own clock and clamps verifiedAt to createdAt, so
-- a clock-skewed database default can never trip this.
ALTER TABLE "LoginVerification" ADD CONSTRAINT "LoginVerification_verified_after_created"
    CHECK ("verifiedAt" IS NULL OR "verifiedAt" >= "createdAt");

-- Lock it like every other table. ENABLE (not FORCE) leaves the server's
-- BYPASSRLS role unaffected.
ALTER TABLE "LoginVerification" ENABLE ROW LEVEL SECURITY;

-- Guarded: `anon` and `authenticated` do not exist in the plain Postgres the e2e
-- harness builds from these migrations.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "LoginVerification" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "LoginVerification" FROM authenticated';
  END IF;
END
$rls$;
