-- Hand-written: prisma migrate dev refuses on the shared dev DB (checksum drift).
--
-- Rich-text notices. ADDITIVE and NULLABLE, with NO BACKFILL:
--   - "contentJson" NULL is the only spelling of "a plain-text notice" — every
--     row before this, and anything main's old code writes during the deploy
--     window. Those render exactly as they always have.
--   - "content" is untouched and still NOT NULL. For a rich notice the API
--     writes the plain text DERIVED from the JSON there, so the bell, the
--     pinned banner, every preview and Announcement_content_sane keep working
--     without knowing the JSON exists.
ALTER TABLE "Announcement" ADD COLUMN "contentJson"   JSONB;
ALTER TABLE "Announcement" ADD COLUMN "coverImageUrl" TEXT;

-- The server's allowlist is the real gate on the JSON (node and mark types, URL
-- rules, a 64 KB cap). This is the backstop against a seed or fix-up script that
-- writes something that is not even a document.
ALTER TABLE "Announcement"
    ADD CONSTRAINT "Announcement_contentJson_is_doc"
    CHECK ("contentJson" IS NULL
           OR (jsonb_typeof("contentJson") = 'object' AND "contentJson"->>'type' = 'doc'));

-- An image the browser will fetch on every member's dashboard: https only, and
-- bounded. The API additionally requires it to be an object it minted in the
-- public `announcements` bucket; that rule depends on SUPABASE_URL, which the
-- database does not know, so only its scheme is enforced here.
ALTER TABLE "Announcement"
    ADD CONSTRAINT "Announcement_coverImageUrl_https"
    CHECK ("coverImageUrl" IS NULL
           OR (left("coverImageUrl", 8) = 'https://' AND char_length("coverImageUrl") <= 2048));
