-- Hand-written: `prisma migrate dev` still refuses against the shared dev
-- database over checksum drift and offers only a reset.
--
-- STAFF & ACCESS. Two tables:
--
--   StaffInvitation — an admin invites an email address to join as FRONT_DESK,
--     COACH or ADMIN. The ROLE LIVES ON THIS ROW: whoever accepts sends only
--     the token, so no client can ask for a different role. Only the SHA-256
--     of the token is stored; the raw token exists only in the link.
--
--   CoachProfile — what members read about a coach: up to five
--     specializations and a short bio.
--
-- Every CHECK and the partial unique index below live ONLY here. Prisma has no
-- way to express them, so a `db push`, a `migrate diff` or a regenerated
-- migration drops them silently. test/staff-constraints.e2e-spec.ts asserts
-- each one by name AND predicate.

-- ── StaffInvitation ──────────────────────────────────────────────────────

CREATE TABLE "StaffInvitation" (
    "id"           UUID           NOT NULL,
    "email"        TEXT           NOT NULL,
    "role"         "Role"         NOT NULL,
    "tokenHash"    CHAR(64)       NOT NULL,
    "invitedById"  UUID           NOT NULL,
    "expiresAt"    TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt"   TIMESTAMPTZ(3),
    "acceptedById" UUID,
    "revokedAt"    TIMESTAMPTZ(3),
    "revokedById"  UUID,
    "createdAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StaffInvitation_tokenHash_key" ON "StaffInvitation"("tokenHash");
CREATE INDEX "StaffInvitation_createdAt_idx" ON "StaffInvitation"("createdAt" DESC);
CREATE INDEX "StaffInvitation_email_idx" ON "StaffInvitation"("email");

-- RESTRICT on all three, like every other actor column: an invitation names
-- the people who issued, accepted and withdrew it, and accounts are
-- soft-deleted, so this costs nothing in normal operation.
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_invitedById_fkey"
  FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_acceptedById_fkey"
  FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Staff roles only. CLIENT is not invited — anyone may register — and DEV is
-- assignable by seed or direct database access alone.
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_role_staff"
  CHECK ("role" IN ('FRONT_DESK', 'COACH', 'ADMIN'));

-- One address, one spelling. The accept route compares the signed-in email,
-- lowercased, against this column; a mixed-case row would never match, and
-- the partial unique index below would treat "Ana@" and "ana@" as two people.
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_email_normalised"
  CHECK ("email" = lower(btrim("email")) AND length("email") BETWEEN 3 AND 254);

-- A SHA-256, hex. Never the raw token.
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_token_hash_shape"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

-- Who and when arrive together or not at all.
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_accepted_shape"
  CHECK (("acceptedAt" IS NULL) = ("acceptedById" IS NULL));
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_revoked_shape"
  CHECK (("revokedAt" IS NULL) = ("revokedById" IS NULL));

-- An invitation ends one way. Accepted-then-revoked would leave the role
-- granted and the list saying it never was.
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_single_outcome"
  CHECK ("acceptedAt" IS NULL OR "revokedAt" IS NULL);

ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_expiry_after_issue"
  CHECK ("expiresAt" > "createdAt");

-- AT MOST ONE OPEN INVITATION PER ADDRESS. "Open" is unaccepted and
-- unrevoked; expiry is not in the predicate because an index cannot read the
-- clock. The API supersedes an EXPIRED open row (marks it revoked) in the same
-- transaction that issues its replacement, so this index is what stops two
-- live links for one person — and two admins racing to invite them.
CREATE UNIQUE INDEX "StaffInvitation_one_open_per_email"
  ON "StaffInvitation" ("email")
  WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;

-- ── CoachProfile ─────────────────────────────────────────────────────────

CREATE TABLE "CoachProfile" (
    "userId"          UUID           NOT NULL,
    "specializations" TEXT[]         DEFAULT ARRAY[]::TEXT[],
    "bio"             TEXT,
    "updatedAt"       TIMESTAMPTZ(3) NOT NULL,
    "updatedById"     UUID           NOT NULL,

    CONSTRAINT "CoachProfile_pkey" PRIMARY KEY ("userId")
);

-- CASCADE: the profile is part of the coach's account.
ALTER TABLE "CoachProfile" ADD CONSTRAINT "CoachProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- RESTRICT: the last editor is named, like every other actor column.
ALTER TABLE "CoachProfile" ADD CONSTRAINT "CoachProfile_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A CHECK may not contain a subquery, and "each element is 1-40 characters"
-- needs one. So the per-element rule is a small IMMUTABLE function the CHECK
-- calls — the same move 20260819083833_add_membership_billing makes for its
-- append-only trigger. `search_path` is pinned so the function means the same
-- thing whoever calls it.
CREATE OR REPLACE FUNCTION "coach_specializations_valid"(tags TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT tags IS NOT NULL
     AND cardinality(tags) <= 5
     AND NOT EXISTS (
       SELECT 1 FROM unnest(tags) AS tag
       WHERE tag IS NULL
          OR tag <> btrim(tag)
          OR char_length(tag) NOT BETWEEN 1 AND 40
     )
$$;

-- Functions are EXECUTE-able by PUBLIC by default, which on Supabase means
-- callable by `anon` over /rest/v1/rpc. It is a pure validator, so that would
-- be harmless — but nothing outside this CHECK has a reason to call it. The
-- CHECK itself runs as the writing role, which owns the function.
REVOKE ALL ON FUNCTION "coach_specializations_valid"(TEXT[]) FROM PUBLIC;

-- At most five, each 1-40 characters, trimmed, no NULL entries. The member's
-- My Coach page and the assign picker render these as chips; an empty or
-- padded chip is a rendering bug, and six of them is a paragraph.
ALTER TABLE "CoachProfile" ADD CONSTRAINT "CoachProfile_specializations_shape"
  CHECK ("coach_specializations_valid"("specializations"));

-- NULL means "no bio yet". Present means it says something, and fits the card.
ALTER TABLE "CoachProfile" ADD CONSTRAINT "CoachProfile_bio_shape"
  CHECK ("bio" IS NULL OR (char_length("bio") <= 500 AND length(btrim("bio")) >= 1));

-- ── Row level security ───────────────────────────────────────────────────
--
-- Same lock every other table in this schema carries. Prisma creates plain
-- Postgres tables, and Supabase's default grants give `anon` — the key
-- compiled into the browser bundle — full DML across the public schema. An
-- invitation token hash readable over the REST API would be the whole point
-- of hashing it lost. ENABLE (not FORCE) leaves the server, which connects as
-- a BYPASSRLS role, unaffected while denying every row to anon and
-- authenticated.
ALTER TABLE "StaffInvitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachProfile"    ENABLE ROW LEVEL SECURITY;

-- Guarded because `anon` and `authenticated` are Supabase-only roles: the e2e
-- harness builds this schema in a bare Postgres container, where an unguarded
-- REVOKE fails with 42704 and takes the whole suite down.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "StaffInvitation", "CoachProfile" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "StaffInvitation", "CoachProfile" FROM authenticated';
  END IF;
END
$rls$;
