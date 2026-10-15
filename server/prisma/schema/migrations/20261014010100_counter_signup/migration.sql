-- Counter sign-up (feat/counter-signup, 2026-10-14).
--
-- Hand-written: prisma migrate dev refuses on the shared dev DB (checksum drift).
-- ADDITIVE ONLY: one nullable column and one new table. main's code never reads
-- either, so it keeps running against this schema during the deploy window.
--
-- Every CHECK below lives ONLY here — Prisma cannot represent them — so
-- test/counter-signup-constraints.e2e-spec.ts asserts each name AND predicate.

-- ── 1. The walk-in's email ──────────────────────────────────────────────────
--
-- SHAPE ONLY. "An account-less walk-in must give an email" is enforced by
-- WalkInService, deliberately NOT by a CHECK: a NOT VALID constraint skips
-- existing rows only when it is created, and Postgres re-checks it on every later
-- UPDATE. Production already holds account-less walk-ins with no email, and those
-- rows are still updated (check-out, the auto-close job, voids, "Make member"'s
-- convertedToUserId) — each of which would start failing with a 500.
ALTER TABLE "CheckIn" ADD COLUMN "guestEmail" TEXT;

ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_guest_email_sane"
    CHECK (
      "guestEmail" IS NULL
      OR ("guestEmail" = lower(btrim("guestEmail")) AND char_length("guestEmail") BETWEEN 3 AND 254)
    );

-- ── 2. The member's setup link ──────────────────────────────────────────────
--
-- ONE ROW PER MEMBER. Resend and an email change ROTATE it (new hash, new
-- expiry), so the previous link dies at once. Only the sha256 of the token is
-- stored; the token itself goes into the email and nowhere else.
CREATE TABLE "MemberJoinLink" (
    "id"         UUID           NOT NULL,
    "userId"     UUID           NOT NULL,
    "tokenHash"  CHAR(64)       NOT NULL,
    "issuedAt"   TIMESTAMPTZ(3) NOT NULL,
    "expiresAt"  TIMESTAMPTZ(3) NOT NULL,
    "issuedById" UUID,
    "usedAt"     TIMESTAMPTZ(3),
    "createdAt"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberJoinLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemberJoinLink_userId_key" ON "MemberJoinLink"("userId");
CREATE UNIQUE INDEX "MemberJoinLink_tokenHash_key" ON "MemberJoinLink"("tokenHash");

-- CASCADE: a link is meaningless without its member and must never block a delete.
ALTER TABLE "MemberJoinLink" ADD CONSTRAINT "MemberJoinLink_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, like AssistantSettings.updatedById: the link outlives the staff account.
ALTER TABLE "MemberJoinLink" ADD CONSTRAINT "MemberJoinLink_issuedById_fkey"
    FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MemberJoinLink" ADD CONSTRAINT "MemberJoinLink_token_hash_shape"
    CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "MemberJoinLink" ADD CONSTRAINT "MemberJoinLink_expiry_after_issue"
    CHECK ("expiresAt" > "issuedAt");

ALTER TABLE "MemberJoinLink" ADD CONSTRAINT "MemberJoinLink_used_after_issue"
    CHECK ("usedAt" IS NULL OR "usedAt" >= "issuedAt");

-- Lock it like every other table (see 20261011000000_member_notices). ENABLE (not
-- FORCE) leaves the server's BYPASSRLS role unaffected.
ALTER TABLE "MemberJoinLink" ENABLE ROW LEVEL SECURITY;

-- Guarded: `anon` and `authenticated` do not exist in the plain Postgres the e2e
-- harness builds from these migrations.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "MemberJoinLink" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "MemberJoinLink" FROM authenticated';
  END IF;
END
$rls$;
