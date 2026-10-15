-- Four CHECKs that let through exactly what they were written to refuse — found
-- running the coach-tools and workout e2e suites against Postgres for the first
-- time (2026-09-29). The API validated every one of these cases already, so no
-- bad row is expected in production; these constraints are the floor under it.
--
-- 1-3. JSON shape. Written as
--     jsonb_typeof(body) = 'object' AND jsonb_typeof(body -> 'days') = 'array'
--   When the key is ABSENT, `body -> 'days'` is NULL, jsonb_typeof(NULL) is NULL,
--   `true AND NULL` is NULL — and a CHECK treats NULL as SATISFIED. So `{}` and
--   `{"summary": "s"}` were accepted. COALESCE(…, false) makes a missing key a
--   violation.
--
-- 4. ChatMessage_body_length. `btrim(body)` with no second argument strips
--   SPACES only, so a body of spaces and a line break had length 1 and passed as
--   "not blank". ChatDto trims every kind of whitespace before a message is saved,
--   so none was ever stored; the floor now agrees with it.
--
-- NOT VALID, then VALIDATEd separately, like 20260827000000_member_suspend_fields:
-- each new rule enforces on writes from its first statement, and a surprise row
-- stops this migration cleanly (the file runs in one transaction) instead of
-- leaving a table without the check.
--
-- Names are unchanged; test/chat-constraints.e2e-spec.ts and
-- test/member-workouts-constraints.e2e-spec.ts assert the new predicates.

ALTER TABLE "WorkoutPlan"
  DROP CONSTRAINT "WorkoutPlan_body_shape",
  ADD CONSTRAINT "WorkoutPlan_body_shape"
    CHECK (jsonb_typeof("body") = 'object' AND COALESCE(jsonb_typeof("body" -> 'days') = 'array', false)) NOT VALID;

ALTER TABLE "MemberWorkoutPlan"
  DROP CONSTRAINT "MemberWorkoutPlan_body_shape",
  ADD CONSTRAINT "MemberWorkoutPlan_body_shape"
    CHECK (jsonb_typeof("body") = 'object' AND COALESCE(jsonb_typeof("body" -> 'days') = 'array', false)) NOT VALID;

ALTER TABLE "ExerciseGuide"
  DROP CONSTRAINT "ExerciseGuide_body_shape",
  ADD CONSTRAINT "ExerciseGuide_body_shape"
    CHECK (jsonb_typeof("body") = 'object' AND COALESCE(jsonb_typeof("body" -> 'steps') = 'array', false)) NOT VALID;

ALTER TABLE "ChatMessage"
  DROP CONSTRAINT "ChatMessage_body_length",
  ADD CONSTRAINT "ChatMessage_body_length"
    CHECK (char_length(btrim("body", E' \t\r\n')) >= 1 AND char_length("body") <= 2000) NOT VALID;

ALTER TABLE "WorkoutPlan"       VALIDATE CONSTRAINT "WorkoutPlan_body_shape";
ALTER TABLE "MemberWorkoutPlan" VALIDATE CONSTRAINT "MemberWorkoutPlan_body_shape";
ALTER TABLE "ExerciseGuide"     VALIDATE CONSTRAINT "ExerciseGuide_body_shape";
ALTER TABLE "ChatMessage"       VALIDATE CONSTRAINT "ChatMessage_body_length";
