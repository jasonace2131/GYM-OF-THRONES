-- Coach tools (feat/coach-tools): who may JOIN a private Supabase Realtime channel.
--
-- The chat's live push is Supabase Realtime Broadcast on one private channel per
-- user, `user:<User.id>`. NestJS publishes to it with the service key after a
-- message is saved; the browser only ever listens. The ONLY rule: a signed-in user
-- may receive on their own channel and nobody else's. With "private channels only"
-- switched on in the Supabase dashboard, a join that no policy allows is refused.
--
-- `auth.uid()` is the Supabase Auth user id (the JWT `sub`), which is what the API
-- stores as `User.supabaseId`. The API therefore addresses channels by that id —
-- see server/src/chat/chat-broadcast.ts — and the browser joins
-- 'user:' + session.user.id.
--
-- GUARDED, so this is a no-op on plain Postgres: the scratch and e2e databases have
-- no `realtime` or `auth` schema. Every probe below returns NULL/false there rather
-- than raising — note `to_regclass`/`pg_namespace` joins instead of an
-- `'auth'::regnamespace` cast, which RAISES "schema does not exist" at parse time.
--
-- NEVER FAILS THE DEPLOY. A failed migration blocks every later `migrate deploy`
-- (P3009) until someone resolves it by hand. If the migration role may not create
-- the policy, this WARNS and moves on: chat still works (the client catches up
-- through the API on focus and reconnect), it just is not instant. The owner then
-- runs the CREATE POLICY below once in the Supabase SQL editor.
DO $realtime$
BEGIN
  IF to_regclass('realtime.messages') IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'realtime' AND p.proname = 'topic'
     )
     AND EXISTS (
       SELECT 1
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'auth' AND p.proname = 'uid'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM pg_policies
        WHERE schemaname = 'realtime'
          AND tablename = 'messages'
          AND policyname = 'user reads own private channel'
     )
  THEN
    BEGIN
      EXECUTE $p$CREATE POLICY "user reads own private channel" ON realtime.messages
        FOR SELECT TO authenticated
        USING (realtime.topic() = 'user:' || auth.uid()::text AND extension = 'broadcast')$p$;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE WARNING 'realtime policy NOT created (insufficient privilege) — create "user reads own private channel" on realtime.messages in the Supabase SQL editor';
    END;
  END IF;
END
$realtime$;
