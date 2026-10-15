-- Member notices (class-booking fixes, 2026-10-11): the personal half of the portal
-- bell. A member learns that a waitlist place became a seat, that a class they hold
-- a place in was called off or moved, or that the desk added or removed them —
-- without having to open My Bookings and notice.
--
-- Hand-written: prisma migrate dev refuses on the shared dev DB (checksum drift).
-- ADDITIVE ONLY: one new enum and one new table. Nothing existing is altered, so
-- main's code keeps running against this schema during the deploy window.
--
-- A new table rather than SystemNotification with a recipient column: that table's
-- read state is shared by design and every query over it is unscoped, so one desk
-- click would mark members' notices read and the console would list them. Each row
-- here has exactly one recipient and its own "readAt".
--
-- Every CHECK below lives ONLY here — Prisma cannot represent them — so
-- test/member-notices-constraints.e2e-spec.ts asserts each name AND predicate. A
-- `db push` or a regenerated migration would drop them silently while every
-- service test kept passing.

-- ── Enum ──────────────────────────────────────────────────────────────────────────
-- Every value has a producer in server/src/classes (enums.prisma says which).

CREATE TYPE "MemberNoticeKind" AS ENUM (
  'CLASS_PROMOTED',
  'CLASS_CANCELLED',
  'CLASS_CHANGED',
  'BOOKING_ADDED',
  'BOOKING_REMOVED'
);

-- ── MemberNotice ──────────────────────────────────────────────────────────────────

CREATE TABLE "MemberNotice" (
    -- No database default: Prisma's @default(uuid()) mints it client-side, the same
    -- as every other table here.
    "id"          UUID               NOT NULL,
    "userId"      UUID               NOT NULL,
    "kind"        "MemberNoticeKind" NOT NULL,
    "title"       TEXT               NOT NULL,
    "body"        TEXT,
    "linkPath"    TEXT,
    "subjectType" TEXT,
    "subjectId"   UUID,
    "dedupeKey"   TEXT,
    "readAt"      TIMESTAMPTZ(3),
    "createdAt"   TIMESTAMPTZ(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberNotice_pkey" PRIMARY KEY ("id")
);

-- The bell's exact query: one member's notices, newest first, with the id as the
-- tie-break so a page boundary never repeats or skips a row.
CREATE INDEX "MemberNotice_userId_createdAt_id_idx"
    ON "MemberNotice" ("userId", "createdAt" DESC, "id" DESC);

-- The unread badge's count.
CREATE INDEX "MemberNotice_userId_readAt_idx" ON "MemberNotice" ("userId", "readAt");

-- De-duplication by producer. Notices are written with
-- createMany({ skipDuplicates: true }) on this key, which is what makes a retried
-- request or a double-submitted edit notify once. A plain unique index Prisma owns
-- (NULLs never collide) rather than a partial one, which Prisma would drop on the
-- next unrelated migrate — the reason ClassBooking carries "activeKey".
CREATE UNIQUE INDEX "MemberNotice_dedupeKey_key" ON "MemberNotice" ("dedupeKey");

-- CASCADE: a member's notices are their own personal data and go with them, like
-- their class bookings (ClassBooking_userId_fkey).
ALTER TABLE "MemberNotice" ADD CONSTRAINT "MemberNotice_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One readable line. A blank title renders as an empty row that looks like a broken
-- bell; producers trim to the 120 bound rather than fail the write. The trim names
-- tabs and line breaks too: bare btrim() strips spaces only, the floor gap
-- 20261001000100_constraint_floor_fixes closed for chat.
ALTER TABLE "MemberNotice" ADD CONSTRAINT "MemberNotice_title_sane"
    CHECK (char_length(btrim("title", E' \t\r\n')) BETWEEN 1 AND 120);

-- Optional detail, never blank when present: long enough for a cancel reason
-- (3-300) or a list of what changed, short enough to read in a dropdown.
ALTER TABLE "MemberNotice" ADD CONSTRAINT "MemberNotice_body_sane"
    CHECK ("body" IS NULL OR char_length(btrim("body", E' \t\r\n')) BETWEEN 1 AND 1000);

-- "linkPath" is rendered as a link, so it must stay inside the app: an absolute URL
-- would be an open redirect, and a protocol-relative `//evil.example` is the form
-- that slips past a naive "starts with /" check. The predicate is
-- SystemNotification_link_is_internal's, verbatim (20260906000000).
ALTER TABLE "MemberNotice" ADD CONSTRAINT "MemberNotice_link_is_internal" CHECK (
    "linkPath" IS NULL
    OR (
      "linkPath" LIKE '/%'
      AND "linkPath" NOT LIKE '//%'
      -- No backslash. A backslash is what browsers normalise into a
      -- protocol-relative URL, which is how `/\evil.example` escapes a naive
      -- "starts with a slash" check — `safeNext` on the client rejects the
      -- same character for the same reason.
      --
      -- `chr(92)` rather than a quoted backslash: inside a LIKE pattern the
      -- backslash is the escape character, so `NOT LIKE '%\%'` quietly reads
      -- as "no literal percent sign" and lets every backslash through. Naming
      -- the code point leaves nothing for a LIKE parser, a shell, or a future
      -- editor to reinterpret.
      AND strpos("linkPath", chr(92)) = 0
    )
  );

-- What the notice is about is a type and an id together, or neither: half a subject
-- names nothing.
ALTER TABLE "MemberNotice" ADD CONSTRAINT "MemberNotice_subject_shape"
    CHECK (("subjectType" IS NULL) = ("subjectId" IS NULL));

-- Deliberately NO "readAt" >= "createdAt" rule: the two can come from different
-- clocks (the query engine's request time, a raw INSERT's CURRENT_TIMESTAMP, another
-- API instance), and a few milliseconds of skew would turn a harmless read into a
-- failed write.

-- ── Lock it like every other table ────────────────────────────────────────────────
-- Prisma creates plain Postgres tables, and Supabase's default grants give `anon` —
-- the key compiled into the browser bundle — and `authenticated` full DML across the
-- public schema. A member's notices must not be readable through the REST API; the
-- browser's only door is NestJS. ENABLE (not FORCE) leaves the server, which
-- connects as a BYPASSRLS role, unaffected while denying every row to anon and
-- authenticated.
ALTER TABLE "MemberNotice" ENABLE ROW LEVEL SECURITY;

-- Guarded: `anon` and `authenticated` are Supabase's roles and do not exist in the
-- plain Postgres the e2e harness builds from these same migrations, where an
-- unguarded REVOKE fails with 42704 and takes the whole suite down.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "MemberNotice" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "MemberNotice" FROM authenticated';
  END IF;
END
$rls$;
