-- Announcements: one table, and the guards every table in this schema carries.

CREATE TABLE "Announcement" (
    "id"        UUID         NOT NULL,
    "title"     TEXT         NOT NULL,
    "content"   TEXT         NOT NULL,
    "isPinned"  BOOLEAN      NOT NULL DEFAULT false,
    "authorId"  UUID         NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- Covers the member feed's exact ORDER BY (pinned first, then newest), so the
-- list never sorts in memory.
CREATE INDEX "Announcement_isPinned_createdAt_idx"
    ON "Announcement" ("isPinned" DESC, "createdAt" DESC);
CREATE INDEX "Announcement_authorId_idx" ON "Announcement" ("authorId");

-- RESTRICT, not CASCADE. Staff leave; the notice that the gym closes early on
-- the 25th does not stop being true when their account is removed.
ALTER TABLE "Announcement"
    ADD CONSTRAINT "Announcement_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Length bounds live in SQL as well as in the DTO. The DTO stops a bad request;
-- this stops a bad INSERT from anywhere else — a seed, a fix-up script, a
-- future service that forgets the DTO. CHECK constraints have no Prisma
-- representation, so they exist only here and only the e2e integrity suite
-- notices if a `migrate diff` ever drops them.
ALTER TABLE "Announcement"
    ADD CONSTRAINT "Announcement_title_sane"
    CHECK (char_length(btrim("title")) BETWEEN 1 AND 120);

ALTER TABLE "Announcement"
    ADD CONSTRAINT "Announcement_content_sane"
    CHECK (char_length(btrim("content")) BETWEEN 1 AND 4000);

-- Same lock every other table in this schema carries. Prisma creates plain
-- Postgres tables, and Supabase's default grants give `anon` — the key
-- compiled into the browser bundle — full DML across the public schema. ENABLE
-- (not FORCE) leaves the server, which connects as a BYPASSRLS role,
-- unaffected while denying every row to anon and authenticated.
ALTER TABLE "Announcement" ENABLE ROW LEVEL SECURITY;

-- Guarded because `anon` and `authenticated` are Supabase-only roles: the e2e
-- harness builds this schema in a bare Postgres container, where an unguarded
-- REVOKE fails with 42704 and takes the whole suite down.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "Announcement" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "Announcement" FROM authenticated';
  END IF;
END
$rls$;
