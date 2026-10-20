-- My account (feat/member-account, 2026-10-20). Hand-written.
--
-- ── 1. The member's opt-in for medical notes in the AI planner ─────────────
-- Off by default (owner): a member's medical notes reach the workout planner's
-- prompts only after they tick "Let the workout planner use my medical notes".
-- ADDITIVE: NOT NULL with a constant default, so every existing row reads
-- false and main's old code, which never names the column, is unaffected.
ALTER TABLE "User" ADD COLUMN "shareMedicalWithPlanner" BOOLEAN NOT NULL DEFAULT false;

-- ── 2. The email-change confirmation link counts as an email link ──────────
-- Re-creates public.login_session_verified() exactly as
-- 20261015000100_login_code_realtime did, with 'email_change' added to the
-- email-link methods: opening the confirmation link of a member's own email
-- change proves inbox access just as a magic link does, and it lands as a
-- fresh session. Matches EMAIL_LINK_AMR_METHODS in
-- server/src/auth/auth-session.ts. Change both together.
--
-- The policy "user reads own private channel" already calls this function, so
-- CREATE OR REPLACE is the whole change; the policy is not touched.
--
-- GUARDED like 20261015000100: a no-op on plain Postgres (no `auth`/`realtime`
-- schema), and it WARNS rather than fails on insufficient privilege, because a
-- failed migration blocks every later deploy (P3009). If it warns, the owner
-- runs the function below in the Supabase SQL editor.
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
                     IN ('otp', 'magiclink', 'invite', 'recovery', 'email_change')
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
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE WARNING 'email_change sign-in rule NOT applied (insufficient privilege) — run migration 20261020000000_share_medical_with_planner''s function in the Supabase SQL editor';
    END;
  END IF;
END
$realtime$;
