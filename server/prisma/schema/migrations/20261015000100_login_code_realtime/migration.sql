-- The emailed sign-in code, applied to live chat (feat/login-code, 2026-10-15).
--
-- The browser subscribes to Supabase Realtime directly with its own token, so
-- the API's gate never sees it. This adds the same rule to the private-channel
-- policy from 20260929000200_realtime_private_channels: the subscribing
-- sign-in must be verified.
--
-- ── 1. The kill switch, readable from SQL ───────────────────────────────────
-- A policy cannot read the API's env, so the API writes LOGIN_CODE_REQUIRED
-- here at every boot (LoginCodeSettingSync). Seeded 'true': fail closed until
-- the API says otherwise.
CREATE TABLE "LoginCodeSetting" (
    "id"        INTEGER        NOT NULL DEFAULT 1,
    "required"  BOOLEAN        NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LoginCodeSetting_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LoginCodeSetting" ADD CONSTRAINT "LoginCodeSetting_single_row"
    CHECK ("id" = 1);

INSERT INTO "LoginCodeSetting" ("id", "required", "updatedAt")
VALUES (1, true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "LoginCodeSetting" ENABLE ROW LEVEL SECURITY;

DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "LoginCodeSetting" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "LoginCodeSetting" FROM authenticated';
  END IF;
END
$rls$;

-- ── 2. The verification check, and the policy that uses it ──────────────────
-- SECURITY DEFINER because the policy runs as `authenticated`, which has had
-- ALL revoked on both tables above (and RLS with no policy would return no
-- rows anyway). The function reveals one boolean about the CALLER'S OWN
-- sign-in. `search_path = ''` and schema-qualified names stop a caller from
-- shadowing anything. A missing setting row reads as required (fail closed).
-- A `session_id` that is not a uuid is never cast (a bad cast would RAISE).
--
-- The email-link methods match EMAIL_LINK_AMR_METHODS in
-- server/src/auth/auth-session.ts. Change both together.
--
-- GUARDED like 20260929000200: a no-op on plain Postgres (no `auth`/`realtime`
-- schema), and it WARNS rather than fails on insufficient privilege, because a
-- failed migration blocks every later deploy (P3009). DROP and CREATE share
-- one sub-transaction, so a failed CREATE never leaves chat with no policy at
-- all. If it warns, the owner runs the statements below in the Supabase SQL
-- editor.
DO $realtime$
BEGIN
  IF to_regclass('realtime.messages') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'realtime' AND p.proname = 'topic'
     )
     AND EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'auth' AND p.proname = 'uid'
     )
     AND EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'auth' AND p.proname = 'jwt'
     )
  THEN
    BEGIN
      EXECUTE $fn$
        CREATE OR REPLACE FUNCTION public.login_session_verified() RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
        AS $body$
          SELECT
            COALESCE((SELECT NOT s."required" FROM public."LoginCodeSetting" s WHERE s."id" = 1), false)
            OR EXISTS (
              SELECT 1 FROM public."LoginVerification" v
               WHERE v."verifiedAt" IS NOT NULL
                 AND v."sessionId" = CASE
                   WHEN (auth.jwt() ->> 'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   THEN (auth.jwt() ->> 'session_id')::uuid
                 END
            )
            OR EXISTS (
              SELECT 1
                FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(auth.jwt() -> 'amr') = 'array'
                            THEN auth.jwt() -> 'amr' ELSE '[]'::jsonb END
                     ) AS a(elem)
               WHERE lower(COALESCE(a.elem ->> 'method', a.elem #>> '{}'))
                     IN ('otp', 'magiclink', 'invite', 'recovery')
            )
        $body$
      $fn$;
      EXECUTE 'REVOKE ALL ON FUNCTION public.login_session_verified() FROM PUBLIC';
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON FUNCTION public.login_session_verified() FROM anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.login_session_verified() TO authenticated';
      END IF;

      EXECUTE 'DROP POLICY IF EXISTS "user reads own private channel" ON realtime.messages';
      EXECUTE $p$CREATE POLICY "user reads own private channel" ON realtime.messages
        FOR SELECT TO authenticated
        USING (
          realtime.topic() = 'user:' || auth.uid()::text
          AND extension = 'broadcast'
          AND public.login_session_verified()
        )$p$;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE WARNING 'login-code realtime rule NOT applied (insufficient privilege) — run migration 20261015000100_login_code_realtime''s function and policy in the Supabase SQL editor';
    END;
  END IF;
END
$realtime$;
